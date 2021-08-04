import { app, errorHandler, uuid, update } from 'mu';
import { json } from 'express';

const subjectMapping = {
  'title': 'terms:title',
  'description': 'terms:description',
  'sessionLocation': '(ext:zitting prov:atLocation)',
  'sessionDate': '(ext:zitting prov:startedAtTime)', //TODO: add besluit:geplandeStart TODO: remove ext:zitting, but not sure how
  'governanceArea': '(ext:zitting besluit:isGehoudenDoor besluit:bestuurt skos:prefLabel)',
}

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

function constraintToSPARQLQuery(res, subject, predicate, object) {
  const newSubject = subjectMapping[subject];

  if (newSubject === undefined) {
    error(res, `Invalid subject: ${subject}`);
    return undefined;
  }

  let shaclConstraint;
  //TODO: Date predicates
  switch (predicate) {
    case 'textEquals':
    case 'governanceAreaEquals':
      shaclConstraint = `sh:pattern "^${object}$";\nsh:flags "i"`;
      break;
    case 'textContains':
      shaclConstraint = `sh:pattern "${object}";\nsh:flags "i"`;
      break;
    case 'exists':
      shaclConstraint = 'sh:minCount 1';
      break;
    case 'notExists':
      shaclConstraint = 'sh:maxCount 0';
      break;
  }

  if (shaclConstraint === undefined) {
    error(res, `Invalid predicate: ${predicate}`);
    return undefined;
  }

  const constraintUri = `http://lokaalbeslist.be/subscription/constraints/${uuid()}`

  return `
  PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
  PREFIX prov: <http://www.w3.org/ns/prov#>
  PREFIX besluit: <http://data.vlaanderen.be/ns/besluit#>
  PREFIX terms: <http://purl.org/dc/terms/>
  PREFIX sh: <http://www.w3.org/ns/shacl#>
  PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

  INSERT {
    GRAPH <http://lokaalbeslist.be/graphs/subscriptions> {
      <${constraintUri}> sh:path ${newSubject};
                         ${shaclConstraint}.
    }
  } WHERE {}
  `
}

function validate_request(req, res, type, attributes) {
  if (!req.body || !req.body.data) {
    error(res, "No data was sent.");
    return false;
  }

  const filter = req.body.data;

  if (filter.type != type) {
    error(res, `Expected type '${type}' but got '${filter.type}'.`);
    return false;
  }

  if (!filter.attributes) {
    error(res, "No attributes specified");
    return false;
  }

  if (attributes) {
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

  return true;
}

app.post('/subscription-filter-constraints', (req, res) => {
  if (!validate_request(
    req,
    res,
    'subscription-filter-constraints',
    ['subject', 'predicate', 'object']
  )) {
    return;
  }

  const attributes = req.body.data.attributes;

  const sparqlQuery = constraintToSPARQLQuery(
    res,
    attributes['subject'],
    attributes['predicate'],
    attributes['object']
  );

  if (sparqlQuery === undefined) {
    return;
  }

  update(sparqlQuery).then((result) => {
    res.send(sparqlQuery + "\n\n\n" + result);
  });

});

app.use(errorHandler);
