const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Express WebSocket API',
      version: '1.0.0',
      description: 'API documentation for Auth and other endpoints',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Development' },
    ],
    components: {
      schemas: {
        AuthSuccess: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'success' },
            message: { type: 'string' },
            data: { $ref: '#/components/schemas/User' },
            token: { type: 'string', description: 'JWT token' },
          },
        },
        AuthError: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'fail' },
            message: { type: 'string' },
          },
        },
        User: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            username: { type: 'string' },
            email: { type: 'string', format: 'email' },
          },
        },
      },
    },
  },
  apis: ['./routes/*.js'],
};

const openapiSpecification = swaggerJsdoc(options);

module.exports = openapiSpecification;
