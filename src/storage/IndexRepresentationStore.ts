import assert from 'assert';
import type { Representation } from '../ldp/representation/Representation';
import type { RepresentationPreferences } from '../ldp/representation/RepresentationPreferences';
import type { ResourceIdentifier } from '../ldp/representation/ResourceIdentifier';
import { NotFoundHttpError } from '../util/errors/NotFoundHttpError';
import { isContainerIdentifier } from '../util/PathUtil';
import type { Conditions } from './Conditions';
import { cleanPreferences, matchesMediaType } from './conversion/ConversionUtil';
import { PassthroughStore } from './PassthroughStore';
import type { ResourceStore } from './ResourceStore';

/**
 * Allow containers to have a custom representation.
 * The index representation will be returned when the following conditions are fulfilled:
 *  * The request targets a container.
 *  * A resource with the given `indexName` exists in the container. (default: "index.html")
 *  * The highest weighted preference matches the `mediaRange` (default: "text/html")
 * Otherwise the request will be passed on to the source store.
 * In case the index representation should always be returned when it exists,
 * the `mediaRange` should be set to "\*∕\*".
 *
 * Note: this functionality is not yet part of the specification. Relevant issues are:
 * - https://github.com/solid/specification/issues/69
 * - https://github.com/solid/specification/issues/198
 * - https://github.com/solid/specification/issues/109
 * - https://github.com/solid/web-access-control-spec/issues/36
 */
export class IndexRepresentationStore extends PassthroughStore {
  private readonly indexName: string;
  private readonly mediaRange: string;

  public constructor(source: ResourceStore, indexName = 'index.html', mediaRange = 'text/html') {
    super(source);
    assert(/^[\w.-]+$/u.test(indexName), 'Invalid index name');
    this.indexName = indexName;
    this.mediaRange = mediaRange;
  }

  public async getRepresentation(identifier: ResourceIdentifier, preferences: RepresentationPreferences,
    conditions?: Conditions): Promise<Representation> {
    if (isContainerIdentifier(identifier) && this.matchesPreferences(preferences)) {
      try {
        const indexIdentifier = { path: `${identifier.path}${this.indexName}` };
        return await this.source.getRepresentation(indexIdentifier, preferences, conditions);
      } catch (error: unknown) {
        if (!NotFoundHttpError.isInstance(error)) {
          throw error;
        }
      }
    }

    return this.source.getRepresentation(identifier, preferences, conditions);
  }

  /**
   * Makes sure the stored media range matches the highest weight preference.
   */
  private matchesPreferences(preferences: RepresentationPreferences): boolean {
    const cleaned = cleanPreferences(preferences.type);
    const max = Math.max(...Object.values(cleaned));
    return Object.entries(cleaned).some(([ range, weight ]): boolean =>
      matchesMediaType(range, this.mediaRange) && weight === max);
  }
}
