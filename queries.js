import { updateSudo, querySudo } from '@lblod/mu-auth-sudo';
import { uuid } from 'mu';
import { error, verifyConstraint } from './helpers';

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
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
    //TODO: remove ext
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
 * Construct a SPARQL query to store a single frontend-contraint into the
 * database.
 *
 * @param {Response} res - The response to send error messages to.
 * @param {string} constraintUri - The URI where the constraint needs to be
 * saved.
 * @param {string} subject - The subject for the constraint.
 * @param {string} predicate - The predicate for the constraint.
 * @param {string} object - The object for the constraint.
 * @returns {(string|undefined)} - The query if the input was valid or undefined
 * if the input was invalid and an error message has been sent back.
 */
export function constraintToSPARQLQuery(res, constraintUri, subject, predicate, object) {
    const newSubject = mapSubject(subject);

    if (newSubject === undefined) {
        error(res, `Invalid subject: ${subject}`);
        return undefined;
    }

    const shaclConstraint = mapPredicateObject(predicate, object);

    if (shaclConstraint === undefined) {
        error(res, `Invalid predicate: ${predicate}`);
        return undefined;
    }

    return `
  PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
  PREFIX prov: <http://www.w3.org/ns/prov#>
  PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
  PREFIX terms: <http://purl.org/dc/terms/>
  PREFIX sh: <http://www.w3.org/ns/shacl#>
  PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

  INSERT {
    GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
      <${constraintUri}> sh:path ${newSubject}.
      <${constraintUri}> ${shaclConstraint}.
    }
  } WHERE {}
  `;
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

      INSERT {
        GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
          <${userURI}> a schema:Person;
                schema:email "${email}".
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

