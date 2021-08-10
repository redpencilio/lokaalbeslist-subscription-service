import { updateSudo, querySudo } from '@lblod/mu-auth-sudo';
import { uuid } from 'mu';
import { error, verifyConstraint } from './helpers';

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 */

/**
 * @typedef {object} SubscriptionFilterConstraint
 * @property {string} id - The id of the constraint.
 * @property {string} subject - The subject of the constraint.
 * @property {string} predicate - The predicate of the constraint.
 * @property {string} object - The object of the constraint.
 */

/**
 * @typedef {object} SubscriptionFilter
 * @property {string} id - The id of the filter.
 * @property {string} email - The email this subscription filter is for.
 * @property {boolean} requireAll - Require all the constraints to be met if
 * true, only one if false.
 * @property {SubscriptionFilterConstraint[]} constraints - The
 * constraints for this filter either as objects or as their IDs.
 */

/**
 * Map a frontend-subject onto a (list of) SPARQL-subject(s)
 *
 * @param {string} subject - The subject to map.
 * @returns {string} - A string that can be put as the **object** of a SPARQL
 * (without trailing period)
 * query. NOTE: this can be multiple lines in the case of a list of objects.
 */
function mapSubject(subject) {
    switch (subject) {
    case 'title':
        return 'terms:title';
    case 'description':
        return 'terms:description';
    //TODO: remove ext with ^
    case 'sessionLocation':
        return createListQuery(['ext:zitting', 'prov:atLocation']);
    case 'sessionDate':
        // TODO: add besluit:geplandeStart
        return createListQuery(['ext:zitting', 'prov:startedAtTime']);
    case 'governanceArea':
        return createListQuery(['ext:zitting',  'besluit:isGehoudenDoor', 'besluit:bestuurt', 'skos:prefLabel' ]);
    }
}

/**
 * Map a frontend-predicate and -object to a SHACL constraint.
 *
 * @param {string} predicate - The predicate to map.
 * @param {string} object - The object to map.
 * @returns {string} - The SHACL constraint that can be used after a subject in
 * a SPARQL query (without trailing period).
 */
function mapPredicateObject(predicate, object) {
    //TODO: Date predicates
    switch (predicate) {
    case 'textEquals':
    case 'governanceAreaEquals':
        return `sh:pattern "^${object}$"; sh:flags "i"`;
    case 'textContains':
        return `sh:pattern "${object}"; sh:flags "i"`;
    case 'exists':
        return 'sh:minCount 1';
    case 'notExists':
        return 'sh:maxCount 0';
    }
}


/**
 * Create a URI for a list item.
 *
 * @returns {string} - The URI that can be used for a list item.
 */
function listURI() {
    return `http://lokaalbeslist.be/subscriptions/list/${uuid()}`;
}

/**
 * Create an RDF list from a list of objects.
 *
 * @param {string[]} items - The list of objects to use.
 * @returns {string} - The part of the query that can be used as an object
 * (without trailing period).
 */
function createListQuery(items) {
    let currentNode = listURI();

    let ret = `<${currentNode}>.\n`;

    for (let i = 0; i < items.length - 1; i++) {
        let nextNode = listURI();
        ret += `<${currentNode}> rdf:first ${items[i]};
    rdf:rest <${nextNode}>.
    `;

        currentNode = nextNode;
    }

    ret += `<${currentNode}> rdf:first ${items[items.length-1]};
  rdf:rest rdf:nil`;

    return ret;
}

/**
 * Find all the filters for the user with the given token.
 *
 * @param {string} token - The token to look up.
 * @returns {Promise<((SubscriptionFilter|undefined)[] | undefined)>} - The list of found
 * filters or undefined if the user doesn't exist.
 */
export async function findFiltersForToken(token) {
    const queryResult = await querySudo(`
        PREFIX account: <http://mu.semte.ch/vocabularies/account/>
        PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>

        SELECT ?filterUri WHERE {
            BIND("${token}" as ?userToken)
            ?user account:password ?userToken;
                  ext:hasSubscription ?filterUri.
        }
    `);

    if (!queryResult || !(queryResult.results)) {
        return undefined;
    }

    return await Promise.all(queryResult.results.bindings.map(async (binding) => {
        return await loadAndConvertFilter(binding['filterUri']['value']);
    }));
}

/**
 * Get the SubscriptionFilterConstraint from a given URI.
 *
 * @param {string} uri - The URI to load.
 * @returns {Promise<SubscriptionFilterConstraint|undefined>} - The
 * corresponding constraint or undefined if the constraint does not exist or is
 * invalid.
 */
async function uriToConstraint(uri) {
    const constraintRequest = await querySudo(`
        PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
        SELECT
            ?subject
            ?predicate
            ?object
        WHERE {
            BIND(<${uri}> as ?constraint)

            ?constraint ext:constraintSubject ?subject;
                        ext:constraintPredicate ?predicate;
                        ext:constraintObject ?object.
        }
    `);

    if (!constraintRequest ||
        !constraintRequest.results ||
        constraintRequest.results.bindings.length == 0) {
        return undefined;
    }

    const constraintBindings = constraintRequest.results.bindings[0];

    const uriParts = uri.split('/');
    return {
        'id': uriParts[uriParts.length - 1],
        'subject': constraintBindings['subject']['value'],
        'predicate': constraintBindings['predicate']['value'],
        'object': constraintBindings['object']['value'],
    };
}

/**
 * Look up a filter URI in the database and return it as a SubscriptionFilter
 *
 * @param {string} uri - The URI to look up.
 * @returns {Promise<SubscriptionFilter|undefined>} - The filter converted to how
 * the frontend expects it or undefined if the filter does not exist.
 */
export async function loadAndConvertFilter(uri) {
    const fullFilterResults = await querySudo(`
        PREFIX sh: <http://www.w3.org/ns/shacl#>

        SELECT ?andOr (GROUP_CONCAT(?constraint ; separator=",") as ?constraints) WHERE {
          BIND(<${uri}> as ?filter)
          ?filter ?andOr ?constraintList.

          ?constraintList rdf:rest*/rdf:first ?constraint

          VALUES ?andOr {
            sh:and
            sh:or
          }
        }
    `);

    if (!fullFilterResults || !fullFilterResults.results) {
        return undefined;
    }

    const fullFilter = fullFilterResults.results.bindings[0];

    const filterUriParts = uri.split('/');
    const constraints = await Promise.all(
        fullFilter['constraints']['value']
            .split(',')
            .map(uriToConstraint)
    );

    return {
        'id': filterUriParts[filterUriParts.length - 1],
        'require-all': fullFilter['andOr']['value'] === 'http://www.w3.org/ns/shacl#and',
        'constraints': constraints.filter(x => !!x),
    };
}

/**
 * Store a new constraint to the database.
 *
 * @param {string} constraintUri - The URI where the constraint needs to be
 * saved.
 * @param {string} subject - The subject for the constraint.
 * @param {string} predicate - The predicate for the constraint.
 * @param {string} object - The object for the constraint.
 * @returns {Promise} - Resolves when the SPARQL query has been executed,
 * rejects with an error message if the input was invalid or the query failed.
 */
export function createConstraint(constraintUri, subject, predicate, object) {
    return new Promise((resolve, reject) => {
        const newSubject = mapSubject(subject);

        if (newSubject === undefined) {
            return reject(`Invalid subject: ${subject}`);
        }

        const shaclConstraint = mapPredicateObject(predicate, object);

        if (shaclConstraint === undefined) {
            return reject(`Invalid predicate: ${predicate}`);
        }

        return updateSudo(`
            PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
            PREFIX prov: <http://www.w3.org/ns/prov#>
            PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
            PREFIX terms: <http://purl.org/dc/terms/>
            PREFIX sh: <http://www.w3.org/ns/shacl#>
            PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
            PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

            INSERT {
            GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
              <${constraintUri}> ext:constraintSubject "${subject}";
                                 ext:constraintPredicate "${predicate}";
                                 ext:constraintObject "${object}";
                                 sh:path ${newSubject}.

              <${constraintUri}> ${shaclConstraint}.
            }
            } WHERE {}
        `).then(resolve).catch(reject);
    });
}

/**
 * Delete a constraint from the database.
 *
 * @param {string} constraintUri - The URI to delete.
 * @param {string} subject - The subject for the constraint.
 * @param {string} predicate - The predicate for the constraint.
 * @param {string} object - The object for the constraint.
 * @returns {Promise} - Resolves when the deletion succeeds, rejects when the
 * SPARQL query fails.
 */
export async function deleteConstraint(constraintUri, subject, predicate, object) {
    return new Promise((resolve, reject) => {
        const newSubject = mapSubject(subject);

        if (newSubject === undefined) {
            return reject(`Invalid subject: ${subject}`);
        }

        const shaclConstraint = mapPredicateObject(predicate, object);

        if (shaclConstraint === undefined) {
            return reject(`Invalid predicate: ${predicate}`);
        }

        //TODO: Deeper cleaning
        return updateSudo(`
            PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
            PREFIX prov: <http://www.w3.org/ns/prov#>
            PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
            PREFIX terms: <http://purl.org/dc/terms/>
            PREFIX sh: <http://www.w3.org/ns/shacl#>
            PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
            PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

            DELETE WHERE {
            GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
                <${constraintUri}> ?p ?o.
              }
            }
        `).then(resolve).catch(reject);
    });
}

/**
 * Construct a SPARQL query to store a single frontend-filter into the database.
 *
 * @param {Response} res - The response to send error message to.
 * @param {string} filterUri - The URI where the filter needs to be saved.
 * @param {boolean} requireAll - Whether or not all the constraints need to be
 * fulfilled (if true) or just one (if false).
 * @param {string} email - The email address of the user.
 * @param {object[]} constraints - The constraints to add to the filter.
 * @returns {Promise<(string|undefined)>} - The query to execute or undefined if the
 * input was invalid and an error message has been sent.
 */
export async function filterToSPARQLQuery(res, filterUri, requireAll, email, constraints) {

    // Check if the constraints are valid
    const invalidConstraintsResults = await Promise.all(constraints.map(
        async (constraint) => !await verifyConstraint(constraint)
    ));

    const invalidConstraints = constraints.filter(
        (_, index) => invalidConstraintsResults[index]
    );

    if (invalidConstraints.length == 1) {
        error(res, `Invalid constraint: '${invalidConstraints[0].id}'.`);
        return undefined;
    } else if (invalidConstraints.length > 1) {
        error(res, `Invalid constraint: '${invalidConstraints.map((x) => x.id).join('\', \'')}'.`);
        return undefined;
    }

    // Check if the user exists and create one if it doesn't
    const userURIQuery = await querySudo(`
    PREFIX schema: <http://schema.org/>

    SELECT ?user WHERE {
      GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
        ?user a schema:Person;
              schema:email "${email}".
      }
    }
  `);

    const userURIBindings = userURIQuery.results.bindings;

    let userURI;
    if (userURIBindings.length === 0) {
        userURI = `http://lokaalbeslist.be/subscriptions/users/${uuid()}`;
        await updateSudo(`
      PREFIX schema: <http://schema.org/>
      PREFIX account: <http://mu.semte.ch/vocabularies/account/>

      INSERT {
        GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
          <${userURI}> a schema:Person;
                schema:email "${email}";
                account:password "${uuid()}".
        }
      } WHERE {}
    `);
    } else {
        console.log(userURIBindings[0]);
        userURI = userURIBindings[0].user.value;
    }

    // Construct the query
    const constraintURIs = constraints.map((constraint) => `<http://lokaalbeslist.be/subscriptions/constraints/${constraint.id}>`);
    return `
  PREFIX sh: <http://www.w3.org/ns/shacl#>
  PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
  PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

  INSERT {
    GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
      <${userURI}> ext:hasSubscription <${filterUri}>.
      <${filterUri}> a sh:NodeShape;
                     sh:targetClass besluit:Agendapunt;
                     ${requireAll ? 'sh:and' : 'sh:or'} ${createListQuery(constraintURIs)}.
    }
  } WHERE {}
  `;
}


/**
 * Check if a constraint with that id exists.
 *
 * @param {string} id - The id.
 * @returns {Promise<boolean>} - True if the constraint exists, false otherwise.
 */
export async function existsConstraint(id) {
    return await querySudo(`
        PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
        ASK WHERE {
            BIND(<http://lokaalbeslist.be/subscriptions/constraints/${id}> as ?constraint)

            ?constraint ext:constraintSubject ?subject;
                        ext:constraintPredicate ?predicate;
                        ext:constraintObject ?object.
        }
    `).then((result) => result.boolean);
}
