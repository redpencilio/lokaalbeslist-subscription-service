import { app, errorHandler, uuid } from 'mu';
import { updateSudo, querySudo } from '@lblod/mu-auth-sudo';
import { json } from 'express';

app.use(json())

function error(res, message, statusCode=400) {
  let errorObject = {
    "detail": message,
    "status": statusCode
  }
  res.status(statusCode).send(JSON.stringify({
    errors: [errorObject]
  }));
}

function listURI() {
  return `http://lokaalbeslist.be/subscriptions/list/${uuid()}`;
}

function createListQuery(items) {
  let currentNode = listURI();

  let ret = `<${currentNode}>.\n`;

  for (let i = 0; i < items.length - 1; i++) {
    let nextNode = listURI();
    ret += `<${currentNode}> rdf:first ${items[i]};
    rdf:rest <${nextNode}>.
    `

    currentNode = nextNode;
  }

  ret += `<${currentNode}> rdf:first ${items[items.length-1]};
  rdf:rest rdf:nil`

  return ret;
}

function mapSubject(subject) {
  switch (subject) {
    case 'title':
      return 'terms:title';
    case 'description':
      return 'terms:description';
    //TODO: remove ext
    case 'sessionLocation':
      return createListQuery(["ext:zitting", "prov:atLocation"]);
    case 'sessionDate':
      return createListQuery(["ext:zitting", "prov:startedAtTime"]); // TODO: add besluit:geplandeStart
    case 'governanceArea':
      return createListQuery(["ext:zitting",  "besluit:isGehoudenDoor", "besluit:bestuurt", "skos:prefLabel" ])
  }
}

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

function constraintToSPARQLQuery(res, constraintUri, subject, predicate, object) {
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
  `
}

function filterToSPARQLQuery(filterUri, requireAll, constraints) {
  const constraintURIs = constraints.map((constraint) => `<http://lokaalbeslist.be/subscriptions/constraints/${constraint.id}>`);
  return `
  PREFIX sh: <http://www.w3.org/ns/shacl#>
  PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

  INSERT {
    GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
      <${filterUri}> a sh:NodeShape;
                     sh:targetClass besluit:Agendapunt;
                     ${requireAll ? 'sh:and' : 'sh:or'} ${createListQuery(constraintURIs)}.
    }
  } WHERE {}
  `
}

function validateRequest(req, res, type, attributes, relationships) {
  if (!req.body || !req.body.data) {
    error(res, "No data was sent.");
    return false;
  }

  const filter = req.body.data;

  if (filter.type != type) {
    error(res, `Expected type '${type}' but got '${filter.type}'.`);
    return false;
  }

  if (attributes) {
    if (!filter.attributes) {
      error(res, "No attributes specified");
      return false;
    }

    const missingAttributes = attributes.filter((attribute) => {
      return !filter.attributes.hasOwnProperty(attribute);
    })

    if (missingAttributes.length == 1) {
      error(res, `Missing attribute: '${missingAttributes[0]}'.`);
      return false;
    } else if (missingAttributes.length > 1) {
      error(res, `Missing attributes: '${missingAttributes.join("', '")}'.`);
      return false;
    }
  }

  if (relationships) {
    if (!filter.relationships) {
      error(res, "No relationships specified");
      return false;
    }

    const missingRelationships = relationships.filter((relationship) => {
      return !(
        filter.relationships.hasOwnProperty(relationship) &&
        filter.relationships[relationship].hasOwnProperty("data")
      );
    })

    if (missingRelationships.length == 1) {
      error(res, `Missing or invalid relationship: '${missingRelationships[0]}'.`);
      return false;
    } else if (missingRelationships.length > 1) {
      error(res, `Missing or invalid relationships: '${missingRelationships.join("', '")}'.`);
      return false;
    }
  }

  return true;
}

async function verifyConstraint(constraint) {
  if (constraint.type !== 'subscription-filter-constraints' || !constraint.hasOwnProperty("id")) {
    return false;
  }

  return await querySudo(`
    PREFIX sh: <http://www.w3.org/ns/shacl#>

    ASK {
      BIND(<http://lokaalbeslist.be/subscriptions/constraints/${constraint.id}> as ?constraint).
      ?constraint sh:path ?x.
    }`
  ).then((res) => res.boolean);
}

app.post('/subscription-filters', async (req, res) => {
  if (!validateRequest(
    req,
    res,
    'subscription-filters',
    ['require-all'],
    ['constraints']
  )) {
    return;
  }

  const resourceId = uuid();
  const filterUri = `http://lokaalbeslist.be/subscriptions/constraints/${resourceId}`
  const attributes = req.body.data.attributes;
  const relationships = req.body.data.relationships;

  const invalidRelationshipResults = await Promise.all(relationships.constraints.data.map(
    async (constraint) => !await verifyConstraint(constraint)
  ));
  
  const invalidRelationships = relationships.constraints.data.filter(
    (_, index) => invalidRelationshipResults[index]
  );

  if (invalidRelationships.length == 1) {
    error(res, `Invalid relationship: '${invalidRelationships[0].id}'.`);
    return;
  } else if (invalidRelationships.length > 1) {
    error(res, `Invalid relationships: '${invalidRelationships.map((x) => x.id).join("', '")}'.`);
    return
  }

  const sparqlQuery = filterToSPARQLQuery(
    filterUri,
    attributes['require-all'],
    relationships.constraints.data,
  )

  querySudo(sparqlQuery).then(() => {
    res.status(201).set("Location", filterUri).send(JSON.stringify({
      "data": {
        "type": "subscription-filters",
        "id": resourceId,
        "attributes": {
          "require-all": attributes["require-all"],
        },
        "relationships": relationships
      }
    }))
  }).catch((err) => {
    console.error(err);
    error(res, "Could not execute SPARQL query", 500);
  });
});

app.post('/subscription-filter-constraints', (req, res) => {
  if (!validateRequest(
    req,
    res,
    'subscription-filter-constraints',
    ['subject', 'predicate', 'object']
  )) {
    return;
  }

  const attributes = req.body.data.attributes;

  const resourceId = uuid();
  const constraintUri = `http://lokaalbeslist.be/subscriptions/constraints/${resourceId}`

  const sparqlQuery = constraintToSPARQLQuery(
    res,
    constraintUri,
    attributes['subject'],
    attributes['predicate'],
    attributes['object']
  );

  if (sparqlQuery === undefined) {
    return;
  }

  updateSudo(sparqlQuery).then(() => {
    res.status(201).set("Location", constraintUri).send(JSON.stringify({
      "data": {
        "type": "subscription-filter-constraints",
        "id": resourceId,
        "attributes": {
          "subject": attributes.subject,
          "predicate": attributes.predicate,
          "object": attributes.object,
        }
      }
    }));
  }).catch((err) => {
    console.error(err);
    error(res, "Could not execute SPARQL query", 500);
  });
});

app.use(errorHandler);
