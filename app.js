import { app, errorHandler, uuid } from 'mu';
import { json } from 'express';
import { 
    createConstraint,
    findFiltersForToken,
    existsConstraint,
    deleteConstraint,
    existsFilter,
    createFilter,
    deleteFilter,
    addSubscription,
    findFilter,
    findConstraint
} from './queries';
import { validateRequest, error } from './helpers';

app.use(json());

app.delete('/subscription-filters/:id', async (req, res) => {
    const filterUri = `http://lokaalbeslist.be/subscriptions/filters/${req.params.id}`;

    if (!await existsFilter(filterUri)) {
        error(res, 'No such filter.', 404);
        return;
    }

    deleteFilter(filterUri)
        .then(() => {
            res.status(204).send();
        }).catch((err) => {
            console.error(err);
            error(res, err, 500);
        });
});

app.delete('/subscription-filter-constraints/:id', async (req, res) => {
    const constraintUri = `http://lokaalbeslist.be/subscriptions/constraints/${req.params.id}`;

    if (!await existsConstraint(constraintUri)) {
        error(res, 'No such constraint.', 404);
        return;
    }

    deleteConstraint(constraintUri)
        .then(() => {
            res.status(204).send();
        }).catch((err) => {
            console.error(err);
            error(res, err, 500);
        });
});

app.patch('/subscription-filters/:id', async (req, res) => {
    if (!validateRequest(
        req,
        res,
        'subscription-filters',
        ['require-all']
    )) {
        return;
    }

    const filterUri = `http://lokaalbeslist.be/subscriptions/filters/${req.params.id}`;

    if (!await existsFilter(filterUri)) {
        error(res, `No such filter: ${req.params.id}`, 404);
        return;
    }

    const attributes = req.body.data.attributes;
    const relationships = req.body.data.relationships;
    const subFilters = (relationships ? relationships['sub-filters'] : undefined);

    deleteFilter(
        filterUri,
    ).then(
        () => createFilter(
            filterUri,
            attributes['require-all'],
            relationships.constraints?.data,
            subFilters
        )
    ).then(() => {
        res.status(201).set('Location', filterUri).send(JSON.stringify({
            'data': {
                'type': 'subscription-filters',
                'id': req.params.id,
                'attributes': {
                    'require-all': attributes['require-all'],
                },
                'relationships': {
                    'sub-filters': subFilters,
                    'constraints': relationships.constraints,
                }
            }
        }));
    }).catch((err) => {
        console.error(err);
        error(res, err);
    });
});

app.patch('/subscription-filter-constraints/:id', async (req, res) => {
    if (!validateRequest(
        req,
        res,
        'subscription-filter-constraints',
        ['subject', 'predicate', 'object']
    )) {
        return;
    }

    const constraintUri = `http://lokaalbeslist.be/subscriptions/constraints/${req.params.id}`;
        
    if (!await existsConstraint(constraintUri)) {
        error(res, 'No such constraint.', 404);
        return;
    }

    const attributes = req.body.data.attributes;

    deleteConstraint(constraintUri)
        .then(() => createConstraint(
            constraintUri,
            attributes['subject'],
            attributes['predicate'],
            attributes['object']
        )).then(() => {
            res.status(201).set('Location', constraintUri).send(JSON.stringify({
                'data': {
                    'type': 'subscription-filter-constraints',
                    'id': req.params.id,
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

app.get('/subscription-filter-constraints/:id', async (req, res) => {
    const constraint = await findConstraint(`http://lokaalbeslist.be/subscriptions/constraints/${req.params.id}`);

    if (!constraint) {
        error(res, 'No such subscription-filter-constraint', 404);
    }

    res.send(JSON.stringify({
        'data': {
            'type': 'subscription-filter-constraints',
            'id': constraint.id,
            'attributes': {
                'subject': constraint.subject,
                'predicate': constraint.predicate,
                'object': constraint.object
            }
        }
    }));
});

app.get('/subscription-filters/:id', async (req, res) => {
    const filter = await findFilter(`http://lokaalbeslist.be/subscriptions/filters/${req.params.id}`);

    if (!filter) {
        error(res, 'No such subscription-filter', 404);
        return;
    }

    const constraintsJSONAPI = filter.constraints.map((constraint) => {
        return {
            'type': 'subscription-filter-constraints',
            'id': constraint.id,
        };
    });

    const subFiltersJSONAPI = filter['sub-filters'].map((subFilter) => {
        return {
            'type': 'subscription-filters',
            'id': subFilter.id,
        };
    });

    res.send(JSON.stringify({
        'data': {
            'type': 'subscription-filters',
            'id': filter.id,
            'attributes': {
                'require-all': filter.requireAll
            },
            'relationships': {
                'constraints': {
                    'data': constraintsJSONAPI,
                },
                'sub-filters': {
                    'data': subFiltersJSONAPI,
                }
            },
        }
    }));

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
    let subFilters = [];

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

        filter['sub-filters'].forEach((subFilter) => {
            subFilters.push(subFilter);
        });
        const subFiltersJSONAPI = filter['sub-filters'].map((subFilter) => {
            return {
                'type': 'subscription-filters',
                'id': subFilter.id,
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
                    'data': constraintsJSONAPI,
                },
                'sub-filters': {
                    'data': subFiltersJSONAPI,
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
        ['require-all']
    )) {
        return;
    }

    const resourceId = uuid();
    const filterUri = `http://lokaalbeslist.be/subscriptions/filters/${resourceId}`;
    const attributes = req.body.data.attributes;
    const relationships = req.body.data.relationships;
    const subFilters = (relationships ? relationships['sub-filters'] : undefined);

    createFilter(
        filterUri,
        attributes['require-all'],
        relationships?.constraints?.data,
        subFilters?.data,
    )
        .then(() => {
            if (attributes['email']) {
                addSubscription(filterUri, attributes['email']);
            }
        })
        .then(() => {
            res.status(201).set('Location', filterUri).send(JSON.stringify({
                'data': {
                    'type': 'subscription-filters',
                    'id': resourceId,
                    'attributes': {
                        'require-all': attributes['require-all'],
                    },
                    'relationships': {
                        'sub-filters': subFilters,
                        'constraints': relationships.constraints,
                    }
                }
            }));
        })
        .catch((err) => {
            console.error(err);
            error(res, err);
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
