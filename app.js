import { app, errorHandler, uuid } from 'mu';
import { querySudo } from '@lblod/mu-auth-sudo';
import { json } from 'express';
import { 
    createConstraint,
    filterToSPARQLQuery,
    findFiltersForToken,
    existsConstraint,
    deleteConstraint
} from './queries';
import { validateRequest, error, verifyConstraint } from './helpers';

app.use(json());

app.patch('/subscription-filter-constraints/:id', async (req, res) => {
    validateRequest(
        req,
        res,
        'subscription-filter-constraints',
        ['subject', 'predicate', 'object']
    );
        
    if (!await existsConstraint(req.params.id)) {
        error(res, 'No such constraint.', 404);
        return;
    }

    const attributes = req.body.data.attributes;
    const resourceId = req.params.id;
    const constraintUri = `http://lokaalbeslist.be/subscriptions/constraints/${resourceId}`;

    deleteConstraint(
        constraintUri,
        attributes['subject'],
        attributes['predicate'],
        attributes['object']
    ).then(
        () => createConstraint(
            constraintUri,
            attributes['subject'],
            attributes['predicate'],
            attributes['object']
        )
    ).then(() => {
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
        error(res, err);
    });
});

app.get('/subscription-filters', async (req, res) => {
    if (req.query['token'] === undefined) {
        error(res, 'Missing token.');
        return;
    }

    const filters = await findFiltersForToken(req.query.token);

    if (!filters || filters.length === 0) {
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

    createConstraint(
        constraintUri,
        attributes['subject'],
        attributes['predicate'],
        attributes['object']
    ).then(() => {
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
        error(res, err);
    });
});

app.use(errorHandler);
