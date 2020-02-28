'use strict'

const Hapi = require('@hapi/hapi')
const fetch = require('node-fetch')
const wrapFetch = require('zipkin-instrumentation-fetch')
const zipkinMiddleware = require('zipkin-instrumentation-hapi').hapiMiddleware
const tracer = require('./tracer')
var pkg = require('zipkin-instrumentation-hapi/package.json');
const {Instrumentation} = require('zipkin')

const middleware = (server, {tracer, serviceName, port = 0}) => {
  const instrumentation = new Instrumentation.HttpServer({tracer, serviceName, port});
  if (tracer == null) throw new Error('No tracer specified');

  server.ext('onRequest', (request, h) => {
    const {headers} = request;
    const readHeader = headerOption.bind(null, headers);

    const traceId = tracer.scoped(
      () => instrumentation.recordRequest(request.method, url.format(request.url), readHeader)
    );

    Object.defineProperty(request, '_trace_id', {configurable: false, get: () => traceId});
    return h.continue;
  });

  server.ext('onPreResponse', (request, h) => {
    const traceId = request._trace_id;
    if (!traceId) return h.continue; // TODO: make a realistic test that could skip this

    const {response} = request;
    const statusCode = response.isBoom ? response.output.statusCode : response.statusCode;

    tracer.scoped(() => instrumentation.recordResponse(traceId, statusCode));

    return h.continue;
  });
};


class TracedServer extends Hapi.Server {  
  constructor(options){
      const tracer = options.tracer;
      delete options.tracer
      super({...options, 
        plugins: {
          zipkin: {
            plugin: {
              name: 'zipkin',
              pkg: pkg,
              register: middleware
            },
            options: { tracer },
          },
        }
      });
  }

  route(routes){
    if (typeof routes === 'object') {
      routes = [routes];
    }
    
    var tracedRoutes = routes.map((route) => {
      if (route.config && route.config.pre) {
        route.config.pre = this.wrapPreHandlers(route.config.pre)
      }
      if (route.hasOwnProperty('handler')) { 
        route.handler = function(request, h) {
          return tracer.scoped(function() {
              tracer.setId(req._trace_id)
              return route.handler(request, h);
          })
        };
      }
    });
    
    super.route(tracedRoutes)
  }

  wrapPreHandlers = function(preHandlers) {
      return preHandlers.map((preHandler) => {
        if (typeof preHandler === 'array') {
          return wrappedHandlers(preHandler);
        }else {
          preHandler.method = function(request, h) {
            return tracer.scoped(function() {
                tracer.setId(req._trace_id);
                preHandler.method(request, h);
            })                            
          };
          return preHandler;
        }
      })
  }
}

const init = async () => {
  const server = new TracedServer({
    port: 3000,
    host: 'localhost',
    tracer
  })
  const zipkinFetch = wrapFetch(fetch, { tracer })

  const headers = {
    'Content-Type': 'application/json',
  }
  const data = {
    method: 'GET',
    headers,
  }
  const doCall = () =>
    zipkinFetch('https://reqres.in/api/users', data)
      .then(res => res.json())
      .then(response => response)

  server.route({
    method: 'GET',
    path: '/',
    config: {
      pre: [
        {
          method: () => {
            return doCall()
          },
          assign: 'users',
        },
        {
          method: () => {
            return doCall()
          },
          assign: 'users2',
        },
        [
          {
            method: () => {
              return doCall()
            },
            assign: 'users3',
          },
          {
            method: () => {
              return doCall()
            },
            assign: 'users4',
          },
          {
            method: () => {
              return doCall()
            },
            assign: 'users5',
          },
        ],
      ],
    },
    handler: request => {
      return request.pre.users
    },
  })

  await server.start()
  console.log('Server running on %s', server.info.uri)
}

process.on('unhandledRejection', err => {
  console.log(err)
  process.exit(1)
})

init()
