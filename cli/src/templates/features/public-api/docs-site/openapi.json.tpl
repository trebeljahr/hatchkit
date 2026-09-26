{
  "openapi": "3.1.0",
  "info": {
    "title": "__HATCHKIT_PROJECT_NAME__ API",
    "version": "1.0.0",
    "description": "The public REST surface of __HATCHKIT_PROJECT_NAME__.\n\nAuthenticate with an API token as `Authorization: Bearer sk_…`. A token is bound to one tenant and carries the permissions its creating member had when it was minted, intersected with that member's permissions right now — it can never show more than its owner may see, and it can never name a tenant of its own."
  },
  "servers": [
    {
      "url": "/",
      "description": "This server."
    }
  ],
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "description": "An API token. Format: `sk_<prefix>_<secret>`."
      }
    },
    "schemas": {
      "Problem": {
        "type": "object",
        "description": "RFC 9457 problem detail. `type` dereferences to documentation for the failure.",
        "properties": {
          "type": {
            "type": "string",
            "format": "uri",
            "examples": [
              "https://example.invalid/problems/insufficient-scope"
            ]
          },
          "title": {
            "type": "string"
          },
          "status": {
            "type": "integer"
          },
          "detail": {
            "type": "string"
          },
          "instance": {
            "type": "string"
          }
        },
        "required": [
          "type",
          "title",
          "status",
          "detail",
          "instance"
        ]
      }
    }
  },
  "security": [
    {
      "bearerAuth": []
    }
  ],
  "paths": {
    "/api/v1/openapi.json": {
      "get": {
        "operationId": "getOpenapijson",
        "summary": "This API's OpenAPI 3.1 document.",
        "tags": [
          "meta"
        ],
        "security": [],
        "responses": {
          "200": {
            "description": "Success.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object"
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/me": {
      "get": {
        "operationId": "getMe",
        "summary": "This token's own tenant, scopes and effective permissions.",
        "tags": [
          "meta"
        ],
        "responses": {
          "200": {
            "description": "Success.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "object",
                      "properties": {
                        "tokenId": {
                          "type": "string"
                        },
                        "tenantId": {
                          "type": "string"
                        },
                        "userId": {
                          "type": "string"
                        },
                        "scopes": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "enum": [
                              "items:read",
                              "items:write",
                              "webhooks:read",
                              "webhooks:write"
                            ]
                          }
                        },
                        "permissions": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "enum": [
                              "items:view-others",
                              "items:write-others",
                              "webhooks:manage"
                            ]
                          }
                        }
                      },
                      "required": [
                        "tokenId",
                        "tenantId",
                        "userId",
                        "scopes",
                        "permissions"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "data"
                  ],
                  "additionalProperties": false
                }
              }
            }
          },
          "400": {
            "description": "The request could not be validated.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, revoked, expired or unknown token — or a token whose member has been removed from the tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "429": {
            "description": "Rate limit exceeded. See `Retry-After`.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              },
              "Retry-After": {
                "description": "Seconds to wait before retrying. Sent only on 429.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "500": {
            "description": "Unexpected server error.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/items": {
      "get": {
        "operationId": "getItems",
        "summary": "List items, newest first. Excludes other members' items without `items:view-others`.",
        "tags": [
          "items"
        ],
        "x-required-scope": "items:read",
        "parameters": [
          {
            "name": "cursor",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "limit",
            "in": "query",
            "required": false,
            "schema": {
              "default": 20,
              "type": "integer",
              "minimum": 1,
              "maximum": 100
            }
          },
          {
            "name": "status",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string",
              "enum": [
                "draft",
                "published",
                "archived"
              ]
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Success.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string"
                          },
                          "title": {
                            "type": "string"
                          },
                          "description": {
                            "type": "string"
                          },
                          "status": {
                            "type": "string",
                            "enum": [
                              "draft",
                              "published",
                              "archived"
                            ]
                          },
                          "ownerId": {
                            "type": "string"
                          },
                          "createdAt": {
                            "type": "string",
                            "format": "date-time",
                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                          },
                          "updatedAt": {
                            "type": "string",
                            "format": "date-time",
                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                          }
                        },
                        "required": [
                          "id",
                          "title",
                          "status",
                          "ownerId",
                          "createdAt",
                          "updatedAt"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "nextCursor": {
                      "type": [
                        "string",
                        "null"
                      ]
                    }
                  },
                  "required": [
                    "data",
                    "nextCursor"
                  ],
                  "additionalProperties": false
                }
              }
            }
          },
          "400": {
            "description": "The request could not be validated.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, revoked, expired or unknown token — or a token whose member has been removed from the tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "403": {
            "description": "The token does not carry the required scope, or may not write this member's row.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "429": {
            "description": "Rate limit exceeded. See `Retry-After`.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              },
              "Retry-After": {
                "description": "Seconds to wait before retrying. Sent only on 429.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "500": {
            "description": "Unexpected server error.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          }
        }
      },
      "post": {
        "operationId": "postItems",
        "summary": "Create an item, owned by the member this token acts as.",
        "tags": [
          "items"
        ],
        "x-required-scope": "items:write",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "description": {
                    "type": "string",
                    "maxLength": 2000
                  }
                },
                "required": [
                  "title"
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Success.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string"
                        },
                        "title": {
                          "type": "string"
                        },
                        "description": {
                          "type": "string"
                        },
                        "status": {
                          "type": "string",
                          "enum": [
                            "draft",
                            "published",
                            "archived"
                          ]
                        },
                        "ownerId": {
                          "type": "string"
                        },
                        "createdAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                        },
                        "updatedAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                        }
                      },
                      "required": [
                        "id",
                        "title",
                        "status",
                        "ownerId",
                        "createdAt",
                        "updatedAt"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "data"
                  ],
                  "additionalProperties": false
                }
              }
            }
          },
          "400": {
            "description": "The request could not be validated.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, revoked, expired or unknown token — or a token whose member has been removed from the tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "403": {
            "description": "The token does not carry the required scope, or may not write this member's row.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "429": {
            "description": "Rate limit exceeded. See `Retry-After`.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              },
              "Retry-After": {
                "description": "Seconds to wait before retrying. Sent only on 429.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "500": {
            "description": "Unexpected server error.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/items/{id}": {
      "get": {
        "operationId": "getItemsById",
        "summary": "One item. 404 for an id in another tenant, never 403.",
        "tags": [
          "items"
        ],
        "x-required-scope": "items:read",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "minLength": 1
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Success.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string"
                        },
                        "title": {
                          "type": "string"
                        },
                        "description": {
                          "type": "string"
                        },
                        "status": {
                          "type": "string",
                          "enum": [
                            "draft",
                            "published",
                            "archived"
                          ]
                        },
                        "ownerId": {
                          "type": "string"
                        },
                        "createdAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                        },
                        "updatedAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                        }
                      },
                      "required": [
                        "id",
                        "title",
                        "status",
                        "ownerId",
                        "createdAt",
                        "updatedAt"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "data"
                  ],
                  "additionalProperties": false
                }
              }
            }
          },
          "400": {
            "description": "The request could not be validated.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, revoked, expired or unknown token — or a token whose member has been removed from the tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "403": {
            "description": "The token does not carry the required scope, or may not write this member's row.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "404": {
            "description": "No such resource in this token's tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "429": {
            "description": "Rate limit exceeded. See `Retry-After`.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              },
              "Retry-After": {
                "description": "Seconds to wait before retrying. Sent only on 429.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "500": {
            "description": "Unexpected server error.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          }
        }
      },
      "patch": {
        "operationId": "patchItemsById",
        "summary": "Edit an item. 403 for another member's item without `items:write-others`.",
        "tags": [
          "items"
        ],
        "x-required-scope": "items:write",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "minLength": 1
            }
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "title": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200
                  },
                  "description": {
                    "type": "string",
                    "maxLength": 2000
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "draft",
                      "published",
                      "archived"
                    ]
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Success.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string"
                        },
                        "title": {
                          "type": "string"
                        },
                        "description": {
                          "type": "string"
                        },
                        "status": {
                          "type": "string",
                          "enum": [
                            "draft",
                            "published",
                            "archived"
                          ]
                        },
                        "ownerId": {
                          "type": "string"
                        },
                        "createdAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                        },
                        "updatedAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                        }
                      },
                      "required": [
                        "id",
                        "title",
                        "status",
                        "ownerId",
                        "createdAt",
                        "updatedAt"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "data"
                  ],
                  "additionalProperties": false
                }
              }
            }
          },
          "400": {
            "description": "The request could not be validated.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, revoked, expired or unknown token — or a token whose member has been removed from the tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "403": {
            "description": "The token does not carry the required scope, or may not write this member's row.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "404": {
            "description": "No such resource in this token's tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "429": {
            "description": "Rate limit exceeded. See `Retry-After`.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              },
              "Retry-After": {
                "description": "Seconds to wait before retrying. Sent only on 429.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "500": {
            "description": "Unexpected server error.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          }
        }
      },
      "delete": {
        "operationId": "deleteItemsById",
        "summary": "Delete an item. Same refusals as the edit.",
        "tags": [
          "items"
        ],
        "x-required-scope": "items:write",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "minLength": 1
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Success.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "object",
                      "properties": {
                        "success": {
                          "type": "boolean",
                          "const": true
                        },
                        "id": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "success",
                        "id"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "data"
                  ],
                  "additionalProperties": false
                }
              }
            }
          },
          "400": {
            "description": "The request could not be validated.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, revoked, expired or unknown token — or a token whose member has been removed from the tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "403": {
            "description": "The token does not carry the required scope, or may not write this member's row.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "404": {
            "description": "No such resource in this token's tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "429": {
            "description": "Rate limit exceeded. See `Retry-After`.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              },
              "Retry-After": {
                "description": "Seconds to wait before retrying. Sent only on 429.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "500": {
            "description": "Unexpected server error.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/webhooks": {
      "get": {
        "operationId": "getWebhooks",
        "summary": "List this tenant's webhook subscriptions. Secrets are never echoed.",
        "tags": [
          "webhooks"
        ],
        "x-required-scope": "webhooks:read",
        "parameters": [
          {
            "name": "cursor",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "limit",
            "in": "query",
            "required": false,
            "schema": {
              "default": 20,
              "type": "integer",
              "minimum": 1,
              "maximum": 100
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Success.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string"
                          },
                          "tenantId": {
                            "type": "string"
                          },
                          "url": {
                            "type": "string"
                          },
                          "events": {
                            "type": "array",
                            "items": {
                              "type": "string",
                              "enum": [
                                "item.created",
                                "item.updated",
                                "item.deleted"
                              ]
                            }
                          },
                          "enabled": {
                            "type": "boolean"
                          },
                          "consecutiveFailures": {
                            "type": "number"
                          },
                          "lastDeliveryAt": {
                            "anyOf": [
                              {
                                "type": "string",
                                "format": "date-time",
                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "disabledAt": {
                            "anyOf": [
                              {
                                "type": "string",
                                "format": "date-time",
                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "createdAt": {
                            "type": "string",
                            "format": "date-time",
                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                          },
                          "updatedAt": {
                            "type": "string",
                            "format": "date-time",
                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                          }
                        },
                        "required": [
                          "id",
                          "tenantId",
                          "url",
                          "events",
                          "enabled",
                          "consecutiveFailures",
                          "lastDeliveryAt",
                          "disabledAt",
                          "createdAt",
                          "updatedAt"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "nextCursor": {
                      "type": [
                        "string",
                        "null"
                      ]
                    }
                  },
                  "required": [
                    "data",
                    "nextCursor"
                  ],
                  "additionalProperties": false
                }
              }
            }
          },
          "400": {
            "description": "The request could not be validated.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, revoked, expired or unknown token — or a token whose member has been removed from the tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "403": {
            "description": "The token does not carry the required scope, or may not write this member's row.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "429": {
            "description": "Rate limit exceeded. See `Retry-After`.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              },
              "Retry-After": {
                "description": "Seconds to wait before retrying. Sent only on 429.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "500": {
            "description": "Unexpected server error.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          }
        }
      },
      "post": {
        "operationId": "postWebhooks",
        "summary": "Create a subscription. The signing secret is returned once, here, and never again.",
        "tags": [
          "webhooks"
        ],
        "x-required-scope": "webhooks:write",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "url": {
                    "type": "string",
                    "maxLength": 2000,
                    "format": "uri"
                  },
                  "events": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "item.created",
                        "item.updated",
                        "item.deleted"
                      ]
                    }
                  }
                },
                "required": [
                  "url",
                  "events"
                ]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Success.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string"
                        },
                        "tenantId": {
                          "type": "string"
                        },
                        "url": {
                          "type": "string"
                        },
                        "events": {
                          "type": "array",
                          "items": {
                            "type": "string",
                            "enum": [
                              "item.created",
                              "item.updated",
                              "item.deleted"
                            ]
                          }
                        },
                        "enabled": {
                          "type": "boolean"
                        },
                        "consecutiveFailures": {
                          "type": "number"
                        },
                        "lastDeliveryAt": {
                          "anyOf": [
                            {
                              "type": "string",
                              "format": "date-time",
                              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "disabledAt": {
                          "anyOf": [
                            {
                              "type": "string",
                              "format": "date-time",
                              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "createdAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                        },
                        "updatedAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                        },
                        "secret": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "id",
                        "tenantId",
                        "url",
                        "events",
                        "enabled",
                        "consecutiveFailures",
                        "lastDeliveryAt",
                        "disabledAt",
                        "createdAt",
                        "updatedAt",
                        "secret"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "data"
                  ],
                  "additionalProperties": false
                }
              }
            }
          },
          "400": {
            "description": "The request could not be validated.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, revoked, expired or unknown token — or a token whose member has been removed from the tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "403": {
            "description": "The token does not carry the required scope, or may not write this member's row.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "429": {
            "description": "Rate limit exceeded. See `Retry-After`.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              },
              "Retry-After": {
                "description": "Seconds to wait before retrying. Sent only on 429.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "500": {
            "description": "Unexpected server error.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/webhooks/{id}/deliveries": {
      "get": {
        "operationId": "getWebhooksByIdDeliveries",
        "summary": "Recent delivery attempts for one subscription, newest first.",
        "tags": [
          "webhooks"
        ],
        "x-required-scope": "webhooks:read",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "minLength": 1
            }
          },
          {
            "name": "cursor",
            "in": "query",
            "required": false,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "limit",
            "in": "query",
            "required": false,
            "schema": {
              "default": 20,
              "type": "integer",
              "minimum": 1,
              "maximum": 100
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Success.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string"
                          },
                          "subscriptionId": {
                            "type": "string"
                          },
                          "event": {
                            "type": "string",
                            "enum": [
                              "item.created",
                              "item.updated",
                              "item.deleted"
                            ]
                          },
                          "status": {
                            "type": "string",
                            "enum": [
                              "pending",
                              "delivered",
                              "failed",
                              "skipped_visibility"
                            ]
                          },
                          "attempt": {
                            "type": "number"
                          },
                          "responseStatus": {
                            "type": [
                              "number",
                              "null"
                            ]
                          },
                          "error": {
                            "type": [
                              "string",
                              "null"
                            ]
                          },
                          "nextAttemptAt": {
                            "anyOf": [
                              {
                                "type": "string",
                                "format": "date-time",
                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "createdAt": {
                            "type": "string",
                            "format": "date-time",
                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                          },
                          "updatedAt": {
                            "type": "string",
                            "format": "date-time",
                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"
                          }
                        },
                        "required": [
                          "id",
                          "subscriptionId",
                          "event",
                          "status",
                          "attempt",
                          "responseStatus",
                          "error",
                          "nextAttemptAt",
                          "createdAt",
                          "updatedAt"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "nextCursor": {
                      "type": [
                        "string",
                        "null"
                      ]
                    }
                  },
                  "required": [
                    "data",
                    "nextCursor"
                  ],
                  "additionalProperties": false
                }
              }
            }
          },
          "400": {
            "description": "The request could not be validated.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, revoked, expired or unknown token — or a token whose member has been removed from the tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "403": {
            "description": "The token does not carry the required scope, or may not write this member's row.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "404": {
            "description": "No such resource in this token's tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "429": {
            "description": "Rate limit exceeded. See `Retry-After`.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              },
              "Retry-After": {
                "description": "Seconds to wait before retrying. Sent only on 429.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "500": {
            "description": "Unexpected server error.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          }
        }
      }
    },
    "/api/v1/webhooks/{id}": {
      "delete": {
        "operationId": "deleteWebhooksById",
        "summary": "Delete a subscription. Queued deliveries for it stop at their next attempt.",
        "tags": [
          "webhooks"
        ],
        "x-required-scope": "webhooks:write",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string",
              "minLength": 1
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Success.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "object",
                      "properties": {
                        "success": {
                          "type": "boolean",
                          "const": true
                        },
                        "id": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "success",
                        "id"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "data"
                  ],
                  "additionalProperties": false
                }
              }
            }
          },
          "400": {
            "description": "The request could not be validated.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, revoked, expired or unknown token — or a token whose member has been removed from the tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "403": {
            "description": "The token does not carry the required scope, or may not write this member's row.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "404": {
            "description": "No such resource in this token's tenant.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "429": {
            "description": "Rate limit exceeded. See `Retry-After`.",
            "headers": {
              "RateLimit-Limit": {
                "description": "Requests this token may make per 60-second window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Remaining": {
                "description": "Requests left in the current window.",
                "schema": {
                  "type": "integer"
                }
              },
              "RateLimit-Reset": {
                "description": "Seconds until the current window rolls over.",
                "schema": {
                  "type": "integer"
                }
              },
              "Retry-After": {
                "description": "Seconds to wait before retrying. Sent only on 429.",
                "schema": {
                  "type": "integer"
                }
              }
            },
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          },
          "500": {
            "description": "Unexpected server error.",
            "content": {
              "application/problem+json": {
                "schema": {
                  "$ref": "#/components/schemas/Problem"
                }
              }
            }
          }
        }
      }
    }
  }
}
