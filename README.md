# LokaalBeslist-subscription-service

Microservice to allow the [LokaalBeslist.be frontend][frontend] to communicate
with the [subscription service][subscription-service] by providing a
JSON:API-like interface that converts the requests from and to the triple store
database.

## Frontend API

### `POST /subscription-filter-constraints`

#### Request

```json
{
  "data": {
    "attributes": {
      "subject": "title",
      "predicate": "textContains",
      "object": "station"
    },
    "type": "subscription-filter-constraints"
  }
}
```

Where `subject`, `predicate` and `object` are as defined in the frontend.

#### Response

`201 Created`: The resource was successfully created, `Location` header is set
and the body contains the created resource.

`400 Bad Request`: Either the request was invalid or execution failed, should
include an error message.

### `POST /subscription-filters`

#### Request

```json
{
  "data": {
    "attributes": {
      "require-all": false,
      "email": "my-email@example.com"
    },
    "relationships": {
      "sub-filters": {
        "data": [
          {
            "type": "subscription-filters",
            "id": "269c59c0-fc0c-11eb-815c-fd786c5905b2"
          }
        ]
      },
      "constraints": {
        "data": [
          {
            "type": "subscription-filter-constraints",
            "id": "26a33790-fc0c-11eb-815c-fd786c5905b2"
          }
        ]
      }
    },
    "type": "subscription-filters"
  }
}
```

Where `require-all` is mandatory, indicating if all the sub-filters and
constraints should be met, or at least one. `email` is not mandatory, when
provided, a new user is created if one with the given email address does not
exist and they are subscribed to the created newsletter. `email` is never sent
back over the API for privacy reasons. `sub-filters` and `constraints` contain
the subscription-filters and subscription-filter-constraints this filter should
consider.

#### Response

`201 Created`: The resource was successfully created, `Location` header is set
and the body contains the created resource (without `email`).

`400 Bad Request`: Either the request was invalid or execution failed, should
include an error message.

### `GET /subscription-filters?token=<token>`

#### Request

`token` should contain a valid user token.

#### Response

`200 OK`: The (possibly empty) list of subscription-filters for the user with
this token, including the top-level subscription-filter-constraints.

`400 Bad Request`: Either the token was invalid, the user not found or execution
failed, should include an error message. 

### `GET /subscription-filters/<id>`

#### Response

`200 OK`: The subscription-filter with this id is returned.

`404 Not Found`: No subscription-filter with that id exists.

### `GET /subscription-filter-constraints/<id>`

#### Response

`200 OK`: The subscription-filter-constraint with this id is returned.

`404 Not Found`: No subscription-filter-constraint with that id exists.

### `PATCH /subscription-filter-constraints/<id>`

#### Request

```json
{
  "data": {
    "id": "4dd50580-fc0e-11eb-b2f8-079ec8885fa9",
    "attributes": {
      "subject": "title",
      "predicate": "textContains",
      "object": "bus"
    },
    "type": "subscription-filter-constraints"
  }
}
```

A **complete** subscription-filter-constraint that will replace the existing
resource.

#### Response

`201 Created`: The resource was successfully replaced.

`404 Not Found`: The resource with the given id was not found.

`400 Bad Request`: Either the request was invalid or execution failed, should
include an error message.

### `PATCH /subscription-filters/<id>`

```json
{
  "data": {
    "id": "4de4bcf0-fc0e-11eb-b2f8-079ec8885fa9",
    "attributes": {
      "require-all": true,
      "email": null
    },
    "relationships": {
      "constraints": {
        "data": [
          {
            "type": "subscription-filter-constraints",
            "id": "4dd50580-fc0e-11eb-b2f8-079ec8885fa9"
          }
        ]
      }
    },
    "type": "subscription-filters"
  }
}
```

A **complete** subscription-filter-constraint without `email` that will replace
the existing resource.

#### Response

`201 Created`: The resource was successfully replaced.

`404 Not Found`: The resource with the given id was not found.

`400 Bad Request`: Either the request was invalid or execution failed, should
include an error message.

### `DELETE /subscription-filter-constraints/<id>`

#### Response

`204 No Content`: The resource was successfully deleted.

`404 Not Found`: The resource with the given id was not found.

### `DELETE /subscription-filters/<id>`

#### Response

`204 No Content`: The resource was successfully deleted.

`404 Not Found`: The resource with the given id was not found.

## Database

All data is saved in the `http://lokaalbeslist.be/graphs/subscriptions` graph.

### subscription-filters

`subscription-filters` are saved as follows:

```ttl
<URI> a sh:NodeShape;
      sh:targetClass besluit:Agendapunt;
      sh:and (or sh:or) <requirements>.
```

Where URI is a URI constructed from the ID
(`http://lokaalbeslist.be/subscriptions/constraints/<ID>`), `sh:and` and `sh:or`
depend on the `requireAll` attribute and `<requirements>` is a linked list of
`subscription-filter-constraints` and/or other `subscription-filters`.

### subscription-filter-constraints

`subscription-filter-constraints` are saved as follows:

```ttl
<URI> ext:containsSubject <subject>;
      ext:containsPredicate <predicate>;
      ext:containsObject <object>;
      sh:path <path>.
<URI> <constraint>.

```

Where URI is a URI constructed from the ID
(`http://lokaalbeslist.be/subscriptions/filters/<ID>`), `<subject>`,
`<predicate>` and `<object>` are the original frontend-subject, -object and
-predicate. `<path>` is a linked list indicating which part of the Agendapunt
needs to be checked (e.g. `^besluit:behandelt -> prov:atLocation`).
`<constraint>` is the SHACL constraint to check, derived from the subject,
object and predicate.

### users and subscriptions

Users are not accessible through the frontend-facing API and are stored as
follows:

```ttl
<URI> a schema:Person;
      schema:email <email>;
      account:password <token>.
```

Where URI is a randomly-generated URI
(`http://lokaalbeslist.be/subscriptions/users/<UUID>`), `<email>` is the users
email and `token` is a generated access token required for requesting the
subscriptions in the frontend.

A user can subscribe to a subscription-filter using the `ext:hasSubscription`
predicate:

```ttl
<userURI> ext:hasSubscription <filterURI>.
```

[frontend]: https://github.com/redpencilio/frontend-lokaalbeslist
[subscription-service]: https://github.com/Robbe7730/subscription-service
