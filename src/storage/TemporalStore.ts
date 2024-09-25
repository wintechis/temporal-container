import type { Representation } from "../http/representation/Representation";
import { RepresentationPreferences } from "../http/representation/RepresentationPreferences";
import type { ResourceIdentifier } from "../http/representation/ResourceIdentifier";
import type { Conditions } from "./conditions/Conditions";
import { PassthroughStore } from "./PassthroughStore";
import type { ResourceStore } from "./ResourceStore";
import { DataFactory, Store, StreamParser } from "n3";
import { BasicRepresentation } from "../http/representation/BasicRepresentation";
import { RepresentationMetadata } from "../http/representation/RepresentationMetadata";
import { once } from "events";
import { parse, toSeconds } from "iso8601-duration";

/* eslint-disable unused-imports/no-unused-vars */
export class TemporalStore<
  T extends ResourceStore = ResourceStore
> extends PassthroughStore<T> {
  public constructor(source: T) {
    super(source);
  }

  public async getRepresentation(
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions
  ): Promise<Representation> {
    // Get time of the request for temporal window stuff later on
    const now = Date.now();

    // Extract and remove search params from uri
    let uri = new URL(identifier.path);
    const searchParams = new URLSearchParams(uri.searchParams);
    uri.search = "";

    // If search parameters are given, do our temporal container processing...
    if (searchParams.size > 0) {
      return new Promise(async (resolve, reject) => {
        // Get the original representation
        let rep: Representation = await this.source.getRepresentation(
          { path: uri.href },
          preferences,
          conditions
        );
        // We do not need the body and to release the lock:
        rep.data.destroy();

        // Only proceed if the resource a temporal container
        if (
          rep.metadata.has(
            DataFactory.namedNode(
              "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
            ),
            DataFactory.namedNode(
              "https://solid.ti.rw.fau.de/public/ns/tc#TemporalContainer"
            )
          )
        ) {
          // Get all resources that are contained in the temporal container
          let containedResources = rep.metadata
            .getAll(DataFactory.namedNode("http://www.w3.org/ns/ldp#contains"))
            .slice(0, 100);

          let promises: Promise<string[][]>[] = [];
          for (let cR of containedResources) {
            // Collect the representations of all contained resources
            promises.push(
              this.source
                .getRepresentation({ path: cR.value }, preferences, conditions)
                .then(async (cRep) => {
                  // Parse the representation to an RDF store
                  let parser = new StreamParser();
                  let store = new Store();
                  cRep.data.pipe(parser);
                  await once(store.import(parser), "end");
                  return store;
                })
                .then((store) => {
                  // Get all sosa:Observations from the store
                  let observations = store.getSubjects(
                    DataFactory.namedNode(
                      "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
                    ),
                    DataFactory.namedNode(
                      "http://www.w3.org/ns/sosa/Observation"
                    ),
                    null
                  );

                  // Iterate through all observations
                  let vs = [];
                  for (let obs of observations) {
                    // Filter based on the observedProperty query parameter
                    if (
                      searchParams.has("observedProperty") &&
                      !store.has(
                        DataFactory.quad(
                          obs,
                          DataFactory.namedNode(
                            "http://www.w3.org/ns/sosa/observedProperty"
                          ),
                          DataFactory.namedNode(
                            searchParams.get("observedProperty")!
                          )
                        )
                      )
                    ) {
                      continue;
                    }

                    // Filter based on the madeBySensor query parameter
                    if (
                      searchParams.has("madeBySensor") &&
                      !store.has(
                        DataFactory.quad(
                          obs,
                          DataFactory.namedNode(
                            "http://www.w3.org/ns/sosa/madeBySensor"
                          ),
                          DataFactory.namedNode(
                            searchParams.get("madeBySensor")!
                          )
                        )
                      )
                    ) {
                      continue;
                    }

                    // Extract timestamp, result and unit from observations
                    let timestamps = store
                      .getObjects(
                        obs,
                        DataFactory.namedNode(
                          "http://www.w3.org/ns/sosa/resultTime"
                        ),
                        null
                      )
                      .map((nn) => nn.value);
                    let results = store
                      .getObjects(
                        obs,
                        DataFactory.namedNode(
                          "http://www.w3.org/ns/sosa/hasResult"
                        ),
                        null
                      )
                      .flatMap((resultObject) => {
                        return [
                          store
                            .getObjects(
                              resultObject,
                              DataFactory.namedNode(
                                "http://qudt.org/vocab/unit/numericValue"
                              ),
                              null
                            )
                            .map((nn) => nn.value),
                          store
                            .getObjects(
                              resultObject,
                              DataFactory.namedNode(
                                "http://qudt.org/schema/qudt/hasUnit"
                              ),
                              null
                            )
                            .map((nn) => nn.value),
                        ];
                      });

                    // If timestamp and result are present, append to the values list
                    if (
                      timestamps.length > 0 &&
                      results.length > 0 &&
                      results[0].length > 0
                    ) {
                      vs.push([timestamps[0], results[0][0], results[1][0]]);
                    }
                  }
                  return vs;
                })
            );
          }

          // Everything so far has been async - now resolve the promises
          let values3d = await Promise.all(promises);
          // Flatten array and remove empty ones
          let values: string[][] = values3d.flat().filter((v) => v.length != 0);

          // Filter based on interval query parameters
          if (searchParams.has("intervalStart")) {
            let start = new Date(
              now.valueOf() -
                toSeconds(parse(searchParams.get("intervalStart")!)) * 1000
            );
            values = values.filter(([ts, va, un]) => new Date(ts) <= start);
          }
          if (searchParams.has("intervalEnd")) {
            let end = new Date(
              now.valueOf() -
                toSeconds(parse(searchParams.get("intervalEnd")!)) * 1000
            );
            values = values.filter(([ts, va, un]) => new Date(ts) >= end);
          }
          if (searchParams.has("intervalAbsoluteStart")) {
            let start = new Date(searchParams.get("intervalAbsoluteStart")!);
            values = values.filter(([ts, va, un]) => new Date(ts) <= start);
          }
          if (searchParams.has("intervalAbsoluteEnd")) {
            let end = new Date(searchParams.get("intervalAbsoluteEnd")!);
            values = values.filter(([ts, va, un]) => new Date(ts) >= end);
          }

          // Save how many observations we have before the value filter is applied 
          // - Needed later on for the box operator
          let orginalValueCount = values.length;

          // Filter based on the value query parameter
          if (searchParams.has("value")) {
            let value = searchParams.get("value")!;
            if (value.startsWith("gte_")) {
              values = values.filter(
                ([ts, va, un]) => va >= value.replace("gte_", "")
              );
            } else if (value.startsWith("gt_")) {
              values = values.filter(
                ([ts, va, un]) => va > value.replace("gt_", "")
              );
            } else if (value.startsWith("lt_")) {
              values = values.filter(
                ([ts, va, un]) => va < value.replace("lt_", "")
              );
            } else if (value.startsWith("lte_")) {
              values = values.filter(
                ([ts, va, un]) => va <= value.replace("lte_", "")
              );
            } else {
              values = values.filter(([ts, va, un]) => va == value);
            }
          }

          // Diamond: Check if at least one observation is left and return result
          if (searchParams.get("operator") == "diamond") {
            resolve(
              new BasicRepresentation(
                `${values.length > 0}`,
                new RepresentationMetadata(
                  { path: uri.href },
                  "application/json"
                )
              )
            );
          } else if (searchParams.get("operator") == "box") {
            // Box: Check if all observations are left after the value filtering
            // step and return result
            resolve(
              new BasicRepresentation(
                `${values.length == orginalValueCount}`,
                new RepresentationMetadata(
                  { path: uri.href },
                  "application/json"
                )
              )
            );
          } else {
            // If no operator is given, return the CSV of all operations
            let csv = values
              .sort()
              .map((v) => `${v[0]}, ${v[1]}, ${v[2]}`)
              .join("\n");
            resolve(
              new BasicRepresentation(
                csv,
                new RepresentationMetadata({ path: uri.href }, "text/csv")
              )
            );
          }
        }
      });
    } else {
      // ... otherwise just return the default representation
      return this.source.getRepresentation(
        { path: uri.href },
        preferences,
        conditions
      );
    }
  }
}
