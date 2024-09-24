import type { Representation } from '../http/representation/Representation';
import { RepresentationPreferences } from '../http/representation/RepresentationPreferences';
import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';
import type { Conditions } from './conditions/Conditions';
import { PassthroughStore } from './PassthroughStore';
import type { ResourceStore } from './ResourceStore';
import { DataFactory, Store, StreamParser } from 'n3';
import { toCanonicalUriPath } from '../util/PathUtil';
import { BasicRepresentation } from '../http/representation/BasicRepresentation';
import { RepresentationMetadata } from '../http/representation/RepresentationMetadata';
import { once } from 'events';
import { parse, toSeconds } from 'iso8601-duration';

/* eslint-disable unused-imports/no-unused-vars */
export class TemporalStore<T extends ResourceStore = ResourceStore> extends PassthroughStore<T> {
  public constructor(source: T) {
    super(source);
  }

  public async getRepresentation(
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions
  ): Promise<Representation> { 
    const now = Date.now();

    // Extract and remove search params from uri
    let uri = new URL(identifier.path);
    const searchParams = new URLSearchParams(uri.searchParams);
    uri.search = '';

    if(searchParams.size > 0) {
      return new Promise(async (resolve, reject) => {
        let rep: Representation = await this.source.getRepresentation({ path: uri.href }, preferences, conditions);
        rep.data.destroy();
        if(rep.metadata.has(
          DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
          DataFactory.namedNode('https://solid.ti.rw.fau.de/public/ns/tc#TemporalContainer')
        )) {
          let values = [];
          let containedResources = rep.metadata.getAll(DataFactory.namedNode('http://www.w3.org/ns/ldp#contains'));
          for(let cR of containedResources) {
            let cRep = await this.source.getRepresentation({ path: cR.value }, preferences, conditions);
            let parser = new StreamParser();
            let store = new Store();
            cRep.data.pipe(parser);
            await once(store.import(parser), 'end');
            let observations = store.getSubjects(
              DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
              DataFactory.namedNode('http://www.w3.org/ns/sosa/Observation'),
              null
            );
            for(let obs of observations) {
              // filter observedProperty
              if(searchParams.has('observedProperty') && !store.has(DataFactory.quad(
                obs,
                DataFactory.namedNode('http://www.w3.org/ns/sosa/observedProperty'),
                DataFactory.namedNode(searchParams.get('observedProperty')!)
              ))) {
                continue;
              }

              // filter madeBySensor
              if(searchParams.has('madeBySensor') && !store.has(DataFactory.quad(
                obs,
                DataFactory.namedNode('http://www.w3.org/ns/sosa/madeBySensor'),
                DataFactory.namedNode(searchParams.get('madeBySensor')!)
              ))) {
                continue;
              }

              let timestamps = store.getObjects(obs, DataFactory.namedNode('http://www.w3.org/ns/sosa/resultTime'), null).map(nn => nn.value);
              let results = store.getObjects(
                obs,
                DataFactory.namedNode('http://www.w3.org/ns/sosa/hasResult'),
                null
              ).flatMap(
                (resultObject) => {
                  return [store.getObjects(
                    resultObject,
                    DataFactory.namedNode('http://qudt.org/vocab/unit/numericValue'),
                    null
                  ).map(nn => nn.value),
                  store.getObjects(
                    resultObject,
                    DataFactory.namedNode('http://qudt.org/schema/qudt/hasUnit'),
                    null
                  ).map(nn => nn.value)];
                }
              )
              if(timestamps.length > 0 && results.length > 0 && results[0].length > 0) {
                values.push([timestamps[0], results[0][0], results[1][0]]);
              } 
            }
          }
          // filter intervals
          if(searchParams.has('intervalStart')) {
            let start = new Date(now.valueOf() - toSeconds(parse(searchParams.get('intervalStart')!)) * 1000);
            values = values.filter(([ts, va, un]) => ts <= start.toISOString());
          }
          if(searchParams.has('intervalEnd')) {
            let end = new Date(now.valueOf() - toSeconds(parse(searchParams.get('intervalEnd')!)) * 1000);
            values = values.filter(([ts, va, un]) => ts >= end.toISOString());
          }
          if(searchParams.has('intervalAbsoluteStart')) {
            let start = new Date(searchParams.get('intervalAbsoluteStart')!);
            values = values.filter(([ts, va, un]) => ts <= start.toISOString());
          }
          if(searchParams.has('intervalAbsoluteEnd')) {
            let end = new Date(searchParams.get('intervalAbsoluteEnd')!);
            values = values.filter(([ts, va, un]) => ts >= end.toISOString());
          }

          let orginalValueCount = values.length;

          if(searchParams.has('value')) {
            let value = searchParams.get('value')!;
            if(value.startsWith('gte_')) {
              values = values.filter(([ts, va, un]) => va >= value.replace('gte_', ''));
            } else if(value.startsWith('gt_')) {
              values = values.filter(([ts, va, un]) => va > value.replace('gt_', ''));
            } else if(value.startsWith('lt_')) {
              values = values.filter(([ts, va, un]) => va < value.replace('lt_', ''));
            } else if(value.startsWith('lte_')) {
              values = values.filter(([ts, va, un]) => va <= value.replace('lte_', ''));
            } else {
              values = values.filter(([ts, va, un]) => va == value);
            }
          }

          // temporal operators
          if(searchParams.get('operator') == 'diamond') {
            resolve(new BasicRepresentation(`${values.length > 0}`, new RepresentationMetadata({ path: uri.href }, 'application/json')));
          } else if(searchParams.get('operator') == 'box') {
            resolve(new BasicRepresentation(`${values.length == orginalValueCount}`, new RepresentationMetadata({ path: uri.href }, 'application/json')));
          } else {
            let csv = values.sort().map(v => `${v[0]}, ${v[1]}, ${v[2]}`).join('\n');
            resolve(new BasicRepresentation(csv, new RepresentationMetadata({ path: uri.href }, 'text/csv')));
          }
        }
      });
    } else {
      return this.source.getRepresentation({ path: uri.href }, preferences, conditions);
    }
  }
}
