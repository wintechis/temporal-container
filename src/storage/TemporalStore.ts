import { BasicRepresentation } from '../http/representation/BasicRepresentation';
import type { Patch } from '../http/representation/Patch';
import type { Representation } from '../http/representation/Representation';
import { RepresentationPreferences } from '../http/representation/RepresentationPreferences';
import type { ResourceIdentifier } from '../http/representation/ResourceIdentifier';
import { ForbiddenHttpError } from '../util/errors/ForbiddenHttpError';
import type { Conditions } from './conditions/Conditions';
import { PassthroughStore } from './PassthroughStore';
import type { ChangeMap, ResourceStore } from './ResourceStore';
import { DataFactory } from 'n3';

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
      let rep: Representation = await this.source.getRepresentation(identifier, preferences, conditions);
      if(rep.metadata.has(
        DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        DataFactory.namedNode('https://solid.ti.rw.fau.de/public/ns/tc#TemporalContainer')
      )) {
        console.log(rep.metadata.quads(
          null,
          DataFactory.namedNode('http://www.w3.org/ns/ldp#contains'),
          null
        ));
      }
      return rep;
  }
}
