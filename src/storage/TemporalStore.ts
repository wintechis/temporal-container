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
          let csv = '';
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
              let timestamps = store.getObjects(obs, DataFactory.namedNode('http://www.w3.org/ns/sosa/resultTime'), null).map(nn => nn.value);
              let results = store.getObjects(
                obs,
                DataFactory.namedNode('http://www.w3.org/ns/sosa/hasResult'),
                null
              ).flatMap(
                resultObject => store.getObjects(
                  resultObject,
                  DataFactory.namedNode('http://qudt.org/vocab/unit/numericValue'),
                  null
                ).map(nn => nn.value)
              )
              if(timestamps.length > 0 && results.length > 0) {
                csv += `${timestamps[0]}, ${results[0]}\n`
              } 
            }
          }
          resolve(new BasicRepresentation(csv, new RepresentationMetadata({ path: uri.href }, 'text/csv')));
        }
      });
    } else {
      return this.source.getRepresentation({ path: uri.href }, preferences, conditions);
    }
  }
}
