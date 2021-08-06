import { querySudo } from '@lblod/mu-auth-sudo';

/**
 * @typedef {import('express').Request} Request
 * @typedef {import('express').Response} Response
 */

/**
 * Verify a single constraint, checking if it has the right (JSON:API) type and
 * if a constraint with that ID exists.
 *
 * @param {object} constraint - The constraint to check.
 * @returns {Promise<boolean>} - True if the constraint is valid and exists, false
 * otherwise.
 */
export async function verifyConstraint(constraint) {
    if (constraint.type !== 'subscription-filter-constraints' ||
        !Object.prototype.hasOwnProperty.call(constraint, 'id')) {
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

/**
 * Send a JSON:API compliant error message.
 *
 * @param {Response} res - The response to send the message to.
 * @param {string} message - The error message itself.
 * @param {number} [statusCode=400] - The status code to use.
 */
export function error(res, message, statusCode=400) {
    let errorObject = {
        'detail': message,
        'status': statusCode
    };
    res.status(statusCode).send(JSON.stringify({
        errors: [errorObject]
    }));
}

/**
 * Validate a JSON:API request body, checking the type, attributes and
 * relationships.
 *
 * @param {Request} req - The request to check.
 * @param {Response} res - The response to send potential error messages to.
 * @param {string} type - The expected type.
 * @param {string[]} [attributes] - The required attributes.
 * @param {string[]} [relationships] - The required relationships.
 * @returns {boolean} - True if the request was valid, false if the request was
 * invalid and an error message has been sent.
 */
export function validateRequest(req, res, type, attributes, relationships) {
    if (!req.body || !req.body.data) {
        error(res, 'No data was sent.');
        return false;
    }

    const filter = req.body.data;

    if (filter.type != type) {
        error(res, `Expected type '${type}' but got '${filter.type}'.`);
        return false;
    }

    if (attributes) {
        if (!filter.attributes) {
            error(res, 'No attributes specified');
            return false;
        }

        const missingAttributes = attributes.filter((attribute) => {
            return !Object.prototype.hasOwnProperty.call(filter.attributes, attribute);
        });

        if (missingAttributes.length == 1) {
            error(res, `Missing attribute: '${missingAttributes[0]}'.`);
            return false;
        } else if (missingAttributes.length > 1) {
            error(res, `Missing attributes: '${missingAttributes.join('\', \'')}'.`);
            return false;
        }
    }

    if (relationships) {
        if (!filter.relationships) {
            error(res, 'No relationships specified');
            return false;
        }

        const missingRelationships = relationships.filter((relationship) => {
            return !(
                Object.prototype.hasOwnProperty.call(filter.relationships, relationship) &&
                Object.prototype.hasOwnProperty.call(filter.relationships[relationship], 'data')
            );
        });

        if (missingRelationships.length == 1) {
            error(res, `Missing or invalid relationship: '${missingRelationships[0]}'.`);
            return false;
        } else if (missingRelationships.length > 1) {
            error(res, `Missing or invalid relationships: '${missingRelationships.join('\', \'')}'.`);
            return false;
        }
    }

    return true;
}

