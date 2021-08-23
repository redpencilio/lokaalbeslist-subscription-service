import { updateSudo, querySudo } from '@lblod/mu-auth-sudo';
import { uuid } from 'mu';
import { verifyConstraint, verifyFilter, escapeSparqlString } from './helpers';

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
 * constraints for this filter.
 * @property {SubscriptionFilter[]} sub-filters - The subfilters that should
 * match as well.
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
    // TODO: Date predicates
    switch (predicate) {
    case 'textEquals':
    case 'governanceAreaEquals':
        return `sh:pattern "^${escapeSparqlString(object)}$"; sh:flags "i"`;
    case 'textContains':
        return `sh:pattern "${escapeSparqlString(object)}"; sh:flags "i"`;
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
        ret += `<${currentNode}> rdf:first ${escapeSparqlString(items[i])};
    rdf:rest <${nextNode}>.
    `;

        currentNode = nextNode;
    }

    ret += `<${currentNode}> rdf:first ${escapeSparqlString(items[items.length-1])};
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
        return await findFilter(binding['filterUri']['value']);
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
export async function findConstraint(uri) {
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
export async function findFilter(uri) {
    const fullFilterResults = await querySudo(`
        PREFIX sh: <http://www.w3.org/ns/shacl#>

        SELECT ?andOr (GROUP_CONCAT(?constraint ; separator=",") as ?constraints) WHERE {
          BIND(<${escapeSparqlString(uri)}> as ?filter)
          ?filter ?andOr ?constraintList.

          ?constraintList rdf:rest*/rdf:first ?constraint

          VALUES ?andOr {
            sh:and
            sh:or
          }
        }
    `);

    if (!fullFilterResults || !fullFilterResults.results || fullFilterResults.results.bindings.length == 0) {
        return undefined;
    }

    const fullFilter = fullFilterResults.results.bindings[0];

    const filterUriParts = uri.split('/');
    const constraints = await Promise.all(
        fullFilter['constraints']['value']
            .split(',')
            .map(findConstraint)
    );
    const subFilters = await Promise.all(
        fullFilter['constraints']['value']
            .split(',')
            .map(findFilter)
            .filter((x) => !!x)
    );

    return {
        'id': filterUriParts[filterUriParts.length - 1],
        'require-all': fullFilter['andOr']['value'] === 'http://www.w3.org/ns/shacl#and',
        'constraints': constraints.filter(x => !!x),
        'sub-filters': subFilters.filter(x => !!x),
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
              <${escapeSparqlString(constraintUri)}> ext:constraintSubject "${escapeSparqlString(subject)}";
                                 ext:constraintPredicate "${escapeSparqlString(predicate)}";
                                 ext:constraintObject "${escapeSparqlString(object)}";
                                 sh:path ${newSubject}.

              <${escapeSparqlString(constraintUri)}> ${shaclConstraint}.
            }
            } WHERE {}
        `).then(resolve).catch(reject);
    });
}

/**
 * Delete a constraint from the database.
 *
 * @param {string} constraintUri - The URI to delete.
 * @returns {Promise} - Resolves when the deletion succeeds, rejects when the
 * SPARQL query fails.
 */
export async function deleteConstraint(constraintUri) {
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
            <${escapeSparqlString(constraintUri)}> ?p ?o.
          }
        }
    `);
}

/**
 * Delete a filter from the database.
 *
 * @param {string} filterUri - The URI to delete.
 * @returns {Promise} - Resolves when the deletion succeeds, rejects when the
 * SPARQL query fails.
 */
export async function deleteFilter(filterUri) {
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
            <${escapeSparqlString(filterUri)}> ?p ?o.
          }
        }
    `);
}

/**
 * Create a filter and store it to the database.
 *
 * @param {string} filterUri - The URI of the filter.
 * @param {boolean} requireAll - Whether or not all the constraints need to be
 * fulfilled (if true) or just one (if false).
 * @param {(object[]|undefined)} constraints - The constraints to add to the filter.
 * @param {(object[]|undefined)} subFilters - The subfilters for this filter.
 */
export function createFilter(filterUri, requireAll, constraints, subFilters) {
    return new Promise((resolve, reject) => {
        let promises = [];

        // Check if the constraints are valid
        if (constraints && constraints.length > 0) {
            Promise.all(constraints.map(
                async (constraint) => !await verifyConstraint(constraint)
            )).then((invalidConstraintsResults) => {
                const invalidConstraints = constraints.filter(
                    (_, index) => invalidConstraintsResults[index]
                );

                if (invalidConstraints.length == 1) {
                    return reject(`Invalid constraint: '${invalidConstraints[0].id}'.`);
                } else if (invalidConstraints.length > 1) {
                    return reject(`Invalid constraint: '${invalidConstraints.map((x) => x.id).join('\', \'')}'.`);
                }
            }).catch(reject);
        }

        // Check if the subfilters are valid.
        if (subFilters && subFilters.length > 0) {
            Promise.all(subFilters.map(
                async (subFilter) => !await verifyFilter(subFilter)
            )).then((invalidSubFilterResults) => {
                const invalidSubFilters = subFilters.filter(
                    (_, index) => invalidSubFilterResults[index]
                );

                if (invalidSubFilters.length == 1) {
                    return reject(`Invalid sub-filter: '${invalidSubFilters[0].id}'.`);
                } else if (invalidSubFilters.length > 1) {
                    return reject(`Invalid sub-filter: '${invalidSubFilters.map((x) => x.id).join('\', \'')}'.`);
                }
            }).catch(reject);
        }

        Promise.all(promises).then(() => {
            let requirements = [];

            if (constraints) {
                constraints.forEach((constraint) =>
                    requirements.push(
                        `<http://lokaalbeslist.be/subscriptions/constraints/${constraint.id}>`
                    )
                );
            }
            if (subFilters) {
                console.log(subFilters);
                subFilters.forEach((subFilter) => 
                    requirements.push(
                        `<http://lokaalbeslist.be/subscriptions/filters/${subFilter.id}>`
                    )
                );
            }

            if (requirements.length === 0) {
                return reject('Need at least one constraint or subFilter');
            }

            return updateSudo(`
                PREFIX sh: <http://www.w3.org/ns/shacl#>
                PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
                PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
                PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

                INSERT DATA {
                  GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
                    <${escapeSparqlString(filterUri)}> a sh:NodeShape;
                                   sh:targetClass besluit:Agendapunt;
                                   ${requireAll ? 'sh:and' : 'sh:or'} ${createListQuery(requirements)}.
                  }
                }
            `).then(resolve).catch(reject);
        }).catch(reject);
    });

}

/**
 * Send the email telling the user they are now subscribed and how they can
 * unsubscribe.
 *
 * @param {string} email - The email address of the user.
 * @param {string} token - The token the user needs to change their preferences.
 */
async function sendSubscriptionEmail(email, token) {
    await updateSudo(`
        PREFIX nmo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nmo#>
        PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
        PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>

        INSERT DATA {
          GRAPH <http://lokaalbeslist.be/graphs/system/email> {
            <http://lokaalbeslist.be/id/emails/${uuid()}> a nmo:Email;
                nmo:messageFrom "lokaalbeslist@semantic.works";
                nmo:emailTo "${escapeSparqlString(email)}";
                nmo:messageSubject "Inschrijving notificaties LokaalBeslist.be";
                nmo:htmlMessageContent "Beste,<br><br>U bent ingeschreven voor notificaties van LokaalBeslist.be. Als u wil uitschrijven voor deze notificaties of uw voorkeuren aanpassen kan dat via volgende link: <a href='http://lokaalbeslist.be/subscriptions?token=${token}'>http://lokaalbeslist.be/subscriptions?token=${token}</a>.<br><br>Met vriendelijke groet,<br>LokaalBeslist.be";
                nmo:sentDate "";
                nmo:isPartOf <http://lokaalbeslist.be/id/mail-folders/2>.
         }
        }
    `);
}

/**
 * Add a subscription to the user with the given email address. This creates a
 * new user if there is no user for the given email address.
 *
 * @param {string} filterUri - The URI to subscribe to.
 * @param {string} email - The email address.
 * @returns {Promise} - Resolves if the subscription was successfully added,
 * rejects if something went wrong.
 */
export function addSubscription(filterUri, email) {
    // Check if the user exists and create one if it doesn't
    return new Promise((resolve, reject) => {
        querySudo(`
            PREFIX schema: <http://schema.org/>

            SELECT ?user WHERE {
              GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
                ?user a schema:Person;
                      schema:email "${escapeSparqlString(email)}".
              }
            }
        `).then((userURIQuery) => {
            const userURIBindings = userURIQuery.results.bindings;

            let userURI;
            if (userURIBindings.length === 0) {
                userURI = `http://lokaalbeslist.be/subscriptions/users/${uuid()}`;
                let userPassword = uuid();
                updateSudo(`
                    PREFIX schema: <http://schema.org/>
                    PREFIX account: <http://mu.semte.ch/vocabularies/account/>

                    INSERT {
                      GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
                        <${userURI}> a schema:Person;
                              schema:email "${escapeSparqlString(email)}";
                              account:password "${userPassword}".
                      }
                    } WHERE {}
                `).then(() => sendSubscriptionEmail(email, userPassword))
                    .catch(reject);
            } else {
                userURI = userURIBindings[0].user.value;
            }

            updateSudo(`
                PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>

                INSERT DATA {
                  GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
                    <${userURI}> ext:hasSubscription <${escapeSparqlString(filterUri)}>.
                  }
                }
            `).then(resolve).catch(reject);
        }).catch(reject);
    });
}

/**
 * Check if a constraint with a given URI exists.
 *
 * @param {string} uri - The URI to check.
 * @returns {Promise<boolean>} - True if the constraint exists, false otherwise.
 */
export async function existsConstraint(uri) {
    return await querySudo(`
        PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
        ASK WHERE {
            BIND(<${escapeSparqlString(uri)}> as ?constraint)

            ?constraint ext:constraintSubject ?subject;
                        ext:constraintPredicate ?predicate;
                        ext:constraintObject ?object.
        }
    `).then((result) => result.boolean);
}

/**
 * Check if a filter with a given URI exists.
 *
 * @param {string} uri - The URI to check.
 * @returns {Promise<boolean>} - True if the filter exists, false otherwise.
 */
export async function existsFilter(uri) {
    return await querySudo(`
        PREFIX sh: <http://www.w3.org/ns/shacl#>
        PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
        PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

        ASK WHERE {
          GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
            <${escapeSparqlString(uri)}> a sh:NodeShape;
                     sh:targetClass besluit:Agendapunt.
          }
        }
    `).then((result) => result.boolean);
}
