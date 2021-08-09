import { app, errorHandler, uuid } from 'mu';
import { updateSudo, querySudo } from '@lblod/mu-auth-sudo';
import { json } from 'express';
import { constraintToSPARQLQuery, filterToSPARQLQuery, findFiltersForToken } from './queries';
import { validateRequest, error } from './helpers';

app.use(json());

app.get('/subscription-filters', async (req, res) => {
    if (req.query['token'] === undefined) {
        error(res, 'Missing token.');
        return;
    }

    const filters = await findFiltersForToken(req.query.token);

    if (!filters) {
        error(res, 'User not found');
        return;
    }

    let constraints = [];

    const filtersJSONAPI = filters.filter((f) => !!f).map((filter) => {
        filter.constraints.forEach((constraint) => {
            constraints.push(constraint);
        });
        const constraintsJSONAPI = filter.constraints.map((constraint) => {
            return {
                'type': 'subscription-filter-constraints',
                'id': constraint.id,
            };
        });
        return {
            'type': 'subscription-filters',
            'id': filter.id,
            'attributes': {
                'require-all': filter['require-all']
            },
            'relationships': {
                'constraints': {
                    'data': constraintsJSONAPI
                }
            },
        };
    });

    res.send(JSON.stringify({
        'data': filtersJSONAPI,
        'included': constraints.map((constraint) => {
            return {
                'type': 'subscription-filter-constraints',
                'id': constraint.id,
                'attributes': {
                    'subject': constraint.subject,
                    'predicate': constraint.predicate,
                    'object': constraint.object
                }
            };
        })
    }));
});

app.post('/subscription-filters', async (req, res) => {
    if (!validateRequest(
        req,
        res,
        'subscription-filters',
        ['require-all', 'email'],
        ['constraints']
    )) {
        return;
    }

    const resourceId = uuid();
    const filterUri = `http://lokaalbeslist.be/subscriptions/constraints/${resourceId}`;
    const attributes = req.body.data.attributes;
    const relationships = req.body.data.relationships;

    const sparqlQuery = await filterToSPARQLQuery(
        res,
        filterUri,
        attributes['require-all'],
        attributes['email'],
        relationships.constraints.data,
    );

    querySudo(sparqlQuery).then(() => {
        res.status(201).set('Location', filterUri).send(JSON.stringify({
            'data': {
                'type': 'subscription-filters',
                'id': resourceId,
                'attributes': {
                    'require-all': attributes['require-all'],
                },
                'relationships': relationships
            }
        }));
    }).catch((err) => {
        console.error(err);
        error(res, 'Could not execute SPARQL query', 500);
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
    const constraintUri = `http://lokaalbeslist.be/subscriptions/constraints/${resourceId}`;

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
        res.status(201).set('Location', constraintUri).send(JSON.stringify({
            'data': {
                'type': 'subscription-filter-constraints',
                'id': resourceId,
                'attributes': {
                    'subject': attributes.subject,
                    'predicate': attributes.predicate,
                    'object': attributes.object,
                }
            }
        }));
    }).catch((err) => {
        console.error(err);
        error(res, 'Could not execute SPARQL query', 500);
    });
});

app.use(errorHandler);
