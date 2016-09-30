/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};

/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {

/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;

/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			exports: {},
/******/ 			id: moduleId,
/******/ 			loaded: false
/******/ 		};

/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);

/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;

/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}


/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;

/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;

/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";

/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	const tplURL = '/w/index.php?title=Test';
	const swt = __webpack_require__(1);
	const HTMLTransformReader = __webpack_require__(16).HTMLTransformReader;
	const streamUtil = __webpack_require__(19);

	swt.precache([tplURL]);
	// swt.options.debug = true;
	swt.router.default = function(request, options) {
	    if (request instanceof Request) {
	        return swt.networkFirst(request, options);
	    } else {
	        return swt.networkFirst(new Request(request), options);
	    }
	};
	swt.options.cache.name = 'default';
	swt.options.cache.maxEntries = 5000;

	let compiledTemplate;
	const pageTemplateTransforms = {
	    transforms: [
	        {
	            selector: 'h1[id="firstHeading"]',
	            handler: (node) => function(ctx) {
	                return `<h1 id="firstHeading">${ctx.htmlTitle}</h1>`;
	            }
	        }, {
	            selector: 'div[id="mw-content-text"]',
	            handler: (node) => function(ctx) {
	                // Use the evaluation context
	                return fetchBody(ctx.req, ctx.title);
	            }
	        }
	    ]
	};

	const bodyExtractTransform = {
	    transforms: [{
	        selector: {
	            nodeName: 'body',
	        },
	        // Simply pass through the stream for now.
	        // Later, we can filter the body stream as well.
	        handler: node => node.innerHTML,
	        stream: true,
	    }],
	    matchOnly: true
	};

	function fetchBody(req, title) {
		const protoHost = req.url.match(/^(https?:\/\/[^\/]+)\//)[1];
	    return swt.cacheFirst(new Request(protoHost + '/api/rest_v1/page/html/'
	                + encodeURIComponent(decodeURIComponent(title))), {
	                    cache: {
	                        name: 'api_html',
	                        maxEntries: 100,
	                        maxAgeSeconds: 186400
	                    }
	    })
	    .then(res => {
	        if (res.status === 200) {
	            // Extract body. This reader returns a ReadableStream for the body in its first value.
	            let reader = new streamUtil.TextDecodeReader(res.body);
	            return new HTMLTransformReader(reader, bodyExtractTransform);
	        } else {
	            return `<body><em style="color: red">Error fetching body for ${title}:
	                ${res.status}<em></body>`;
	        }
	    },
	    err => `<body><em style="color: red">Error fetching body for ${title}:
	            ${err}</em></body>`);
	}

	function getTemplate() {
	    return swt.cacheFirst(new Request(tplURL))
	        .then(res => res.text())
	        .then(tpl => tpl
	            .replace('<base[^>]+href=[^>]+>', '')
	            .replace(/modules=([^&]+)&/,
	                'modules=$1%7Cmediawiki.skinning.content.parsoid%7Cext.cite.style&'));
	}

	const escapes = {
	    '<': '&lt;',
	    '"': '&quot;',
	    "'": '&#39;'
	};

	class HackyReplaceReader {
	    constructor(input, ctx) {
	        this._reader = streamUtil.toReader(input);
	        this._ctx = ctx;
	    }

	    read() {
	        return this._reader.read()
	        .then(res => {
	            if (res.done) {
	                return res;
	            }
	            if (typeof res.value === 'string') {
	                res.value = res.value.replace(/Test/g, this._ctx.htmlTitle);
	            }
	            return res;
	        });
	    }

	    cancel(reason) {
	        this._reader.cancel(reason);
	    }
	}

	function getCompiledTemplate() {
	    if (compiledTemplate) {
	        return Promise.resolve(compiledTemplate);
	    } else {
	        return getTemplate()
	            .then(tpl => {
	                compiledTemplate = new HTMLTransformReader(tpl, pageTemplateTransforms).drainSync();
	                return compiledTemplate;
	            })
	    }
	}

	function assemblePage(req, tpl) {
	    var title = req.url.match(/\/w\/?iki\/([^?]+)$/)[1];
	    const ctx = {
	        req: req,
	        title: title,
	        htmlTitle: title.split('/').map(decodeURIComponent).join('/')
	                         .replace(/[<"']/g, s => escapes[s])
	                         .replace(/_/g, ' ')
	    };

	    // Hacky replaces on the template.
	    // TODO: Move all dynamic bits in the skin to pre-compiled templates /
	    // widgets.
	    let reader = new HackyReplaceReader(tpl, ctx);
	    // Flatten / evaluate stream.
	    reader = new streamUtil.FlatStreamReader(reader, ctx);
	    // Convert to bytes.
	    reader = new streamUtil.TextEncodeReader(reader);
	    // Finally, wrap into a ReadableStream.
	    return streamUtil.toStream(reader);
	}

	swt.router.get(/https?:\/\/[^\/]+\/w\/?iki\/[^?]+$/,
	        (request, options) => {
	            return getCompiledTemplate()
	            .then((tpl) => {
	                const body = assemblePage(request, tpl);
	                return new Response(body, {
	                    headers: {
	                        'content-type': 'text/html;charset=utf8'
	                    }
	                });
	            });
	        });

	// Use cacheFirst for RL requests
	swt.router.get("/w/load.php",
	         (request, options) => {
	             return swt.cacheFirst(request, options);
	         });

	// Boilerplate to ensure our service worker takes control of the page as soon
	// as possible.
	self.addEventListener('install', () => self.skipWaiting());
	self.addEventListener('activate', () => self.clients.claim());


/***/ },
/* 1 */
/***/ function(module, exports, __webpack_require__) {

	/*
	  Copyright 2014 Google Inc. All Rights Reserved.

	  Licensed under the Apache License, Version 2.0 (the "License");
	  you may not use this file except in compliance with the License.
	  You may obtain a copy of the License at

	      http://www.apache.org/licenses/LICENSE-2.0

	  Unless required by applicable law or agreed to in writing, software
	  distributed under the License is distributed on an "AS IS" BASIS,
	  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	  See the License for the specific language governing permissions and
	  limitations under the License.
	*/
	'use strict';

	__webpack_require__(2);
	var options = __webpack_require__(3);
	var router = __webpack_require__(4);
	var helpers = __webpack_require__(8);
	var strategies = __webpack_require__(10);

	helpers.debug('Service Worker Toolbox is loading');

	// Install
	var flatten = function(items) {
	  return items.reduce(function(a, b) {
	    return a.concat(b);
	  }, []);
	};

	var validatePrecacheInput = function(items) {
	  var isValid = Array.isArray(items);
	  if (isValid) {
	    items.forEach(function(item) {
	      if (!(typeof item === 'string' || (item instanceof Request))) {
	        isValid = false;
	      }
	    });
	  }

	  if (!isValid) {
	    throw new TypeError('The precache method expects either an array of ' +
	    'strings and/or Requests or a Promise that resolves to an array of ' +
	    'strings and/or Requests.');
	  }

	  return items;
	};

	self.addEventListener('install', function(event) {
	  var inactiveCache = options.cache.name + '$$$inactive$$$';
	  helpers.debug('install event fired');
	  helpers.debug('creating cache [' + inactiveCache + ']');
	  event.waitUntil(
	    helpers.openCache({cache: {name: inactiveCache}})
	    .then(function(cache) {
	      return Promise.all(options.preCacheItems)
	      .then(flatten)
	      .then(validatePrecacheInput)
	      .then(function(preCacheItems) {
	        helpers.debug('preCache list: ' +
	            (preCacheItems.join(', ') || '(none)'));
	        return cache.addAll(preCacheItems);
	      });
	    })
	  );
	});

	// Activate

	self.addEventListener('activate', function(event) {
	  helpers.debug('activate event fired');
	  var inactiveCache = options.cache.name + '$$$inactive$$$';
	  event.waitUntil(helpers.renameCache(inactiveCache, options.cache.name));
	});

	// Fetch

	self.addEventListener('fetch', function(event) {
	  var handler = router.match(event.request);

	  if (handler) {
	    event.respondWith(handler(event.request));
	  } else if (router.default && event.request.method === 'GET') {
	    event.respondWith(router.default(event.request));
	  }
	});

	// Caching

	function cache(url, options) {
	  return helpers.openCache(options).then(function(cache) {
	    return cache.add(url);
	  });
	}

	function uncache(url, options) {
	  return helpers.openCache(options).then(function(cache) {
	    return cache.delete(url);
	  });
	}

	function precache(items) {
	  if (!(items instanceof Promise)) {
	    validatePrecacheInput(items);
	  }

	  options.preCacheItems = options.preCacheItems.concat(items);
	}

	module.exports = {
	  networkOnly: strategies.networkOnly,
	  networkFirst: strategies.networkFirst,
	  cacheOnly: strategies.cacheOnly,
	  cacheFirst: strategies.cacheFirst,
	  fastest: strategies.fastest,
	  router: router,
	  options: options,
	  cache: cache,
	  uncache: uncache,
	  precache: precache
	};


/***/ },
/* 2 */
/***/ function(module, exports) {

	/**
	 * Copyright 2015 Google Inc. All rights reserved.
	 *
	 * Licensed under the Apache License, Version 2.0 (the "License");
	 * you may not use this file except in compliance with the License.
	 * You may obtain a copy of the License at
	 *
	 *     http://www.apache.org/licenses/LICENSE-2.0
	 *
	 * Unless required by applicable law or agreed to in writing, software
	 * distributed under the License is distributed on an "AS IS" BASIS,
	 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	 * See the License for the specific language governing permissions and
	 * limitations under the License.
	 *
	 */

	(function() {
	  var nativeAddAll = Cache.prototype.addAll;
	  var userAgent = navigator.userAgent.match(/(Firefox|Chrome)\/(\d+\.)/);

	  // Has nice behavior of `var` which everyone hates
	  if (userAgent) {
	    var agent = userAgent[1];
	    var version = parseInt(userAgent[2]);
	  }

	  if (
	    nativeAddAll && (!userAgent ||
	      (agent === 'Firefox' && version >= 46) ||
	      (agent === 'Chrome'  && version >= 50)
	    )
	  ) {
	    return;
	  }

	  Cache.prototype.addAll = function addAll(requests) {
	    var cache = this;

	    // Since DOMExceptions are not constructable:
	    function NetworkError(message) {
	      this.name = 'NetworkError';
	      this.code = 19;
	      this.message = message;
	    }

	    NetworkError.prototype = Object.create(Error.prototype);

	    return Promise.resolve().then(function() {
	      if (arguments.length < 1) throw new TypeError();

	      // Simulate sequence<(Request or USVString)> binding:
	      var sequence = [];

	      requests = requests.map(function(request) {
	        if (request instanceof Request) {
	          return request;
	        }
	        else {
	          return String(request); // may throw TypeError
	        }
	      });

	      return Promise.all(
	        requests.map(function(request) {
	          if (typeof request === 'string') {
	            request = new Request(request);
	          }

	          var scheme = new URL(request.url).protocol;

	          if (scheme !== 'http:' && scheme !== 'https:') {
	            throw new NetworkError("Invalid scheme");
	          }

	          return fetch(request.clone());
	        })
	      );
	    }).then(function(responses) {
	      // If some of the responses has not OK-eish status,
	      // then whole operation should reject
	      if (responses.some(function(response) {
	        return !response.ok;
	      })) {
	        throw new NetworkError('Incorrect response status');
	      }

	      // TODO: check that requests don't overwrite one another
	      // (don't think this is possible to polyfill due to opaque responses)
	      return Promise.all(
	        responses.map(function(response, i) {
	          return cache.put(requests[i], response);
	        })
	      );
	    }).then(function() {
	      return undefined;
	    });
	  };

	  Cache.prototype.add = function add(request) {
	    return this.addAll([request]);
	  };
	}());

/***/ },
/* 3 */
/***/ function(module, exports) {

	/*
		Copyright 2015 Google Inc. All Rights Reserved.

		Licensed under the Apache License, Version 2.0 (the "License");
		you may not use this file except in compliance with the License.
		You may obtain a copy of the License at

	      http://www.apache.org/licenses/LICENSE-2.0

		Unless required by applicable law or agreed to in writing, software
		distributed under the License is distributed on an "AS IS" BASIS,
		WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
		See the License for the specific language governing permissions and
		limitations under the License.
	*/
	'use strict';

	// TODO: This is necessary to handle different implementations in the wild
	// The spec defines self.registration, but it was not implemented in Chrome 40.
	var scope;
	if (self.registration) {
	  scope = self.registration.scope;
	} else {
	  scope = self.scope || new URL('./', self.location).href;
	}

	module.exports = {
	  cache: {
	    name: '$$$toolbox-cache$$$' + scope + '$$$',
	    maxAgeSeconds: null,
	    maxEntries: null
	  },
	  debug: false,
	  networkTimeoutSeconds: null,
	  preCacheItems: [],
	  // A regular expression to apply to HTTP response codes. Codes that match
	  // will be considered successes, while others will not, and will not be
	  // cached.
	  successResponses: /^0|([123]\d\d)|(40[14567])|410$/
	};


/***/ },
/* 4 */
/***/ function(module, exports, __webpack_require__) {

	/*
	  Copyright 2014 Google Inc. All Rights Reserved.

	  Licensed under the Apache License, Version 2.0 (the "License");
	  you may not use this file except in compliance with the License.
	  You may obtain a copy of the License at

	      http://www.apache.org/licenses/LICENSE-2.0

	  Unless required by applicable law or agreed to in writing, software
	  distributed under the License is distributed on an "AS IS" BASIS,
	  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	  See the License for the specific language governing permissions and
	  limitations under the License.
	*/
	'use strict';

	var Route = __webpack_require__(5);
	var helpers = __webpack_require__(8);

	function regexEscape(s) {
	  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
	}

	var keyMatch = function(map, string) {
	  // This would be better written as a for..of loop, but that would break the
	  // minifyify process in the build.
	  var entriesIterator = map.entries();
	  var item = entriesIterator.next();
	  var matches = [];
	  while (!item.done) {
	    var pattern = new RegExp(item.value[0]);
	    if (pattern.test(string)) {
	      matches.push(item.value[1]);
	    }
	    item = entriesIterator.next();
	  }
	  return matches;
	};

	var Router = function() {
	  this.routes = new Map();
	  // Create the dummy origin for RegExp-based routes
	  this.routes.set(RegExp, new Map());
	  this.default = null;
	};

	['get', 'post', 'put', 'delete', 'head', 'any'].forEach(function(method) {
	  Router.prototype[method] = function(path, handler, options) {
	    return this.add(method, path, handler, options);
	  };
	});

	Router.prototype.add = function(method, path, handler, options) {
	  options = options || {};
	  var origin;

	  if (path instanceof RegExp) {
	    // We need a unique key to use in the Map to distinguish RegExp paths
	    // from Express-style paths + origins. Since we can use any object as the
	    // key in a Map, let's use the RegExp constructor!
	    origin = RegExp;
	  } else {
	    origin = options.origin || self.location.origin;
	    if (origin instanceof RegExp) {
	      origin = origin.source;
	    } else {
	      origin = regexEscape(origin);
	    }
	  }

	  method = method.toLowerCase();

	  var route = new Route(method, path, handler, options);

	  if (!this.routes.has(origin)) {
	    this.routes.set(origin, new Map());
	  }

	  var methodMap = this.routes.get(origin);
	  if (!methodMap.has(method)) {
	    methodMap.set(method, new Map());
	  }

	  var routeMap = methodMap.get(method);
	  var regExp = route.regexp || route.fullUrlRegExp;

	  if (routeMap.has(regExp.source)) {
	    helpers.debug('"' + path + '" resolves to same regex as existing route.');
	  }

	  routeMap.set(regExp.source, route);
	};

	Router.prototype.matchMethod = function(method, url) {
	  var urlObject = new URL(url);
	  var origin = urlObject.origin;
	  var path = urlObject.pathname;

	  // We want to first check to see if there's a match against any
	  // "Express-style" routes (string for the path, RegExp for the origin).
	  // Checking for Express-style matches first maintains the legacy behavior.
	  // If there's no match, we next check for a match against any RegExp routes,
	  // where the RegExp in question matches the full URL (both origin and path).
	  return this._match(method, keyMatch(this.routes, origin), path) ||
	    this._match(method, [this.routes.get(RegExp)], url);
	};

	Router.prototype._match = function(method, methodMaps, pathOrUrl) {
	  if (methodMaps.length === 0) {
	    return null;
	  }

	  for (var i = 0; i < methodMaps.length; i++) {
	    var methodMap = methodMaps[i];
	    var routeMap = methodMap && methodMap.get(method.toLowerCase());
	    if (routeMap) {
	      var routes = keyMatch(routeMap, pathOrUrl);
	      if (routes.length > 0) {
	        return routes[0].makeHandler(pathOrUrl);
	      }
	    }
	  }

	  return null;
	};

	Router.prototype.match = function(request) {
	  return this.matchMethod(request.method, request.url) ||
	      this.matchMethod('any', request.url);
	};

	module.exports = new Router();


/***/ },
/* 5 */
/***/ function(module, exports, __webpack_require__) {

	/*
	  Copyright 2014 Google Inc. All Rights Reserved.

	  Licensed under the Apache License, Version 2.0 (the "License");
	  you may not use this file except in compliance with the License.
	  You may obtain a copy of the License at

	      http://www.apache.org/licenses/LICENSE-2.0

	  Unless required by applicable law or agreed to in writing, software
	  distributed under the License is distributed on an "AS IS" BASIS,
	  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	  See the License for the specific language governing permissions and
	  limitations under the License.
	*/
	'use strict';

	// TODO: Use self.registration.scope instead of self.location
	var url = new URL('./', self.location);
	var basePath = url.pathname;
	var pathRegexp = __webpack_require__(6);

	var Route = function(method, path, handler, options) {
	  if (path instanceof RegExp) {
	    this.fullUrlRegExp = path;
	  } else {
	    // The URL() constructor can't parse express-style routes as they are not
	    // valid urls. This means we have to manually manipulate relative urls into
	    // absolute ones. This check is extremely naive but implementing a tweaked
	    // version of the full algorithm seems like overkill
	    // (https://url.spec.whatwg.org/#concept-basic-url-parser)
	    if (path.indexOf('/') !== 0) {
	      path = basePath + path;
	    }

	    this.keys = [];
	    this.regexp = pathRegexp(path, this.keys);
	  }

	  this.method = method;
	  this.options = options;
	  this.handler = handler;
	};

	Route.prototype.makeHandler = function(url) {
	  var values;
	  if (this.regexp) {
	    var match = this.regexp.exec(url);
	    values = {};
	    this.keys.forEach(function(key, index) {
	      values[key.name] = match[index + 1];
	    });
	  }

	  return function(request) {
	    return this.handler(request, values, this.options);
	  }.bind(this);
	};

	module.exports = Route;


/***/ },
/* 6 */
/***/ function(module, exports, __webpack_require__) {

	var isarray = __webpack_require__(7)

	/**
	 * Expose `pathToRegexp`.
	 */
	module.exports = pathToRegexp
	module.exports.parse = parse
	module.exports.compile = compile
	module.exports.tokensToFunction = tokensToFunction
	module.exports.tokensToRegExp = tokensToRegExp

	/**
	 * The main path matching regexp utility.
	 *
	 * @type {RegExp}
	 */
	var PATH_REGEXP = new RegExp([
	  // Match escaped characters that would otherwise appear in future matches.
	  // This allows the user to escape special characters that won't transform.
	  '(\\\\.)',
	  // Match Express-style parameters and un-named parameters with a prefix
	  // and optional suffixes. Matches appear as:
	  //
	  // "/:test(\\d+)?" => ["/", "test", "\d+", undefined, "?", undefined]
	  // "/route(\\d+)"  => [undefined, undefined, undefined, "\d+", undefined, undefined]
	  // "/*"            => ["/", undefined, undefined, undefined, undefined, "*"]
	  '([\\/.])?(?:(?:\\:(\\w+)(?:\\(((?:\\\\.|[^\\\\()])+)\\))?|\\(((?:\\\\.|[^\\\\()])+)\\))([+*?])?|(\\*))'
	].join('|'), 'g')

	/**
	 * Parse a string for the raw tokens.
	 *
	 * @param  {string} str
	 * @return {!Array}
	 */
	function parse (str) {
	  var tokens = []
	  var key = 0
	  var index = 0
	  var path = ''
	  var res

	  while ((res = PATH_REGEXP.exec(str)) != null) {
	    var m = res[0]
	    var escaped = res[1]
	    var offset = res.index
	    path += str.slice(index, offset)
	    index = offset + m.length

	    // Ignore already escaped sequences.
	    if (escaped) {
	      path += escaped[1]
	      continue
	    }

	    var next = str[index]
	    var prefix = res[2]
	    var name = res[3]
	    var capture = res[4]
	    var group = res[5]
	    var modifier = res[6]
	    var asterisk = res[7]

	    // Push the current path onto the tokens.
	    if (path) {
	      tokens.push(path)
	      path = ''
	    }

	    var partial = prefix != null && next != null && next !== prefix
	    var repeat = modifier === '+' || modifier === '*'
	    var optional = modifier === '?' || modifier === '*'
	    var delimiter = res[2] || '/'
	    var pattern = capture || group || (asterisk ? '.*' : '[^' + delimiter + ']+?')

	    tokens.push({
	      name: name || key++,
	      prefix: prefix || '',
	      delimiter: delimiter,
	      optional: optional,
	      repeat: repeat,
	      partial: partial,
	      asterisk: !!asterisk,
	      pattern: escapeGroup(pattern)
	    })
	  }

	  // Match any characters still remaining.
	  if (index < str.length) {
	    path += str.substr(index)
	  }

	  // If the path exists, push it onto the end.
	  if (path) {
	    tokens.push(path)
	  }

	  return tokens
	}

	/**
	 * Compile a string to a template function for the path.
	 *
	 * @param  {string}             str
	 * @return {!function(Object=, Object=)}
	 */
	function compile (str) {
	  return tokensToFunction(parse(str))
	}

	/**
	 * Prettier encoding of URI path segments.
	 *
	 * @param  {string}
	 * @return {string}
	 */
	function encodeURIComponentPretty (str) {
	  return encodeURI(str).replace(/[\/?#]/g, function (c) {
	    return '%' + c.charCodeAt(0).toString(16).toUpperCase()
	  })
	}

	/**
	 * Encode the asterisk parameter. Similar to `pretty`, but allows slashes.
	 *
	 * @param  {string}
	 * @return {string}
	 */
	function encodeAsterisk (str) {
	  return encodeURI(str).replace(/[?#]/g, function (c) {
	    return '%' + c.charCodeAt(0).toString(16).toUpperCase()
	  })
	}

	/**
	 * Expose a method for transforming tokens into the path function.
	 */
	function tokensToFunction (tokens) {
	  // Compile all the tokens into regexps.
	  var matches = new Array(tokens.length)

	  // Compile all the patterns before compilation.
	  for (var i = 0; i < tokens.length; i++) {
	    if (typeof tokens[i] === 'object') {
	      matches[i] = new RegExp('^(?:' + tokens[i].pattern + ')$')
	    }
	  }

	  return function (obj, opts) {
	    var path = ''
	    var data = obj || {}
	    var options = opts || {}
	    var encode = options.pretty ? encodeURIComponentPretty : encodeURIComponent

	    for (var i = 0; i < tokens.length; i++) {
	      var token = tokens[i]

	      if (typeof token === 'string') {
	        path += token

	        continue
	      }

	      var value = data[token.name]
	      var segment

	      if (value == null) {
	        if (token.optional) {
	          // Prepend partial segment prefixes.
	          if (token.partial) {
	            path += token.prefix
	          }

	          continue
	        } else {
	          throw new TypeError('Expected "' + token.name + '" to be defined')
	        }
	      }

	      if (isarray(value)) {
	        if (!token.repeat) {
	          throw new TypeError('Expected "' + token.name + '" to not repeat, but received `' + JSON.stringify(value) + '`')
	        }

	        if (value.length === 0) {
	          if (token.optional) {
	            continue
	          } else {
	            throw new TypeError('Expected "' + token.name + '" to not be empty')
	          }
	        }

	        for (var j = 0; j < value.length; j++) {
	          segment = encode(value[j])

	          if (!matches[i].test(segment)) {
	            throw new TypeError('Expected all "' + token.name + '" to match "' + token.pattern + '", but received `' + JSON.stringify(segment) + '`')
	          }

	          path += (j === 0 ? token.prefix : token.delimiter) + segment
	        }

	        continue
	      }

	      segment = token.asterisk ? encodeAsterisk(value) : encode(value)

	      if (!matches[i].test(segment)) {
	        throw new TypeError('Expected "' + token.name + '" to match "' + token.pattern + '", but received "' + segment + '"')
	      }

	      path += token.prefix + segment
	    }

	    return path
	  }
	}

	/**
	 * Escape a regular expression string.
	 *
	 * @param  {string} str
	 * @return {string}
	 */
	function escapeString (str) {
	  return str.replace(/([.+*?=^!:${}()[\]|\/\\])/g, '\\$1')
	}

	/**
	 * Escape the capturing group by escaping special characters and meaning.
	 *
	 * @param  {string} group
	 * @return {string}
	 */
	function escapeGroup (group) {
	  return group.replace(/([=!:$\/()])/g, '\\$1')
	}

	/**
	 * Attach the keys as a property of the regexp.
	 *
	 * @param  {!RegExp} re
	 * @param  {Array}   keys
	 * @return {!RegExp}
	 */
	function attachKeys (re, keys) {
	  re.keys = keys
	  return re
	}

	/**
	 * Get the flags for a regexp from the options.
	 *
	 * @param  {Object} options
	 * @return {string}
	 */
	function flags (options) {
	  return options.sensitive ? '' : 'i'
	}

	/**
	 * Pull out keys from a regexp.
	 *
	 * @param  {!RegExp} path
	 * @param  {!Array}  keys
	 * @return {!RegExp}
	 */
	function regexpToRegexp (path, keys) {
	  // Use a negative lookahead to match only capturing groups.
	  var groups = path.source.match(/\((?!\?)/g)

	  if (groups) {
	    for (var i = 0; i < groups.length; i++) {
	      keys.push({
	        name: i,
	        prefix: null,
	        delimiter: null,
	        optional: false,
	        repeat: false,
	        partial: false,
	        asterisk: false,
	        pattern: null
	      })
	    }
	  }

	  return attachKeys(path, keys)
	}

	/**
	 * Transform an array into a regexp.
	 *
	 * @param  {!Array}  path
	 * @param  {Array}   keys
	 * @param  {!Object} options
	 * @return {!RegExp}
	 */
	function arrayToRegexp (path, keys, options) {
	  var parts = []

	  for (var i = 0; i < path.length; i++) {
	    parts.push(pathToRegexp(path[i], keys, options).source)
	  }

	  var regexp = new RegExp('(?:' + parts.join('|') + ')', flags(options))

	  return attachKeys(regexp, keys)
	}

	/**
	 * Create a path regexp from string input.
	 *
	 * @param  {string}  path
	 * @param  {!Array}  keys
	 * @param  {!Object} options
	 * @return {!RegExp}
	 */
	function stringToRegexp (path, keys, options) {
	  var tokens = parse(path)
	  var re = tokensToRegExp(tokens, options)

	  // Attach keys back to the regexp.
	  for (var i = 0; i < tokens.length; i++) {
	    if (typeof tokens[i] !== 'string') {
	      keys.push(tokens[i])
	    }
	  }

	  return attachKeys(re, keys)
	}

	/**
	 * Expose a function for taking tokens and returning a RegExp.
	 *
	 * @param  {!Array}  tokens
	 * @param  {Object=} options
	 * @return {!RegExp}
	 */
	function tokensToRegExp (tokens, options) {
	  options = options || {}

	  var strict = options.strict
	  var end = options.end !== false
	  var route = ''
	  var lastToken = tokens[tokens.length - 1]
	  var endsWithSlash = typeof lastToken === 'string' && /\/$/.test(lastToken)

	  // Iterate over the tokens and create our regexp string.
	  for (var i = 0; i < tokens.length; i++) {
	    var token = tokens[i]

	    if (typeof token === 'string') {
	      route += escapeString(token)
	    } else {
	      var prefix = escapeString(token.prefix)
	      var capture = '(?:' + token.pattern + ')'

	      if (token.repeat) {
	        capture += '(?:' + prefix + capture + ')*'
	      }

	      if (token.optional) {
	        if (!token.partial) {
	          capture = '(?:' + prefix + '(' + capture + '))?'
	        } else {
	          capture = prefix + '(' + capture + ')?'
	        }
	      } else {
	        capture = prefix + '(' + capture + ')'
	      }

	      route += capture
	    }
	  }

	  // In non-strict mode we allow a slash at the end of match. If the path to
	  // match already ends with a slash, we remove it for consistency. The slash
	  // is valid at the end of a path match, not in the middle. This is important
	  // in non-ending mode, where "/test/" shouldn't match "/test//route".
	  if (!strict) {
	    route = (endsWithSlash ? route.slice(0, -2) : route) + '(?:\\/(?=$))?'
	  }

	  if (end) {
	    route += '$'
	  } else {
	    // In non-ending mode, we need the capturing groups to match as much as
	    // possible by using a positive lookahead to the end or next path segment.
	    route += strict && endsWithSlash ? '' : '(?=\\/|$)'
	  }

	  return new RegExp('^' + route, flags(options))
	}

	/**
	 * Normalize the given path string, returning a regular expression.
	 *
	 * An empty array can be passed in for the keys, which will hold the
	 * placeholder key descriptions. For example, using `/user/:id`, `keys` will
	 * contain `[{ name: 'id', delimiter: '/', optional: false, repeat: false }]`.
	 *
	 * @param  {(string|RegExp|Array)} path
	 * @param  {(Array|Object)=}       keys
	 * @param  {Object=}               options
	 * @return {!RegExp}
	 */
	function pathToRegexp (path, keys, options) {
	  keys = keys || []

	  if (!isarray(keys)) {
	    options = /** @type {!Object} */ (keys)
	    keys = []
	  } else if (!options) {
	    options = {}
	  }

	  if (path instanceof RegExp) {
	    return regexpToRegexp(path, /** @type {!Array} */ (keys))
	  }

	  if (isarray(path)) {
	    return arrayToRegexp(/** @type {!Array} */ (path), /** @type {!Array} */ (keys), options)
	  }

	  return stringToRegexp(/** @type {string} */ (path), /** @type {!Array} */ (keys), options)
	}


/***/ },
/* 7 */
/***/ function(module, exports) {

	module.exports = Array.isArray || function (arr) {
	  return Object.prototype.toString.call(arr) == '[object Array]';
	};


/***/ },
/* 8 */
/***/ function(module, exports, __webpack_require__) {

	/*
	  Copyright 2014 Google Inc. All Rights Reserved.

	  Licensed under the Apache License, Version 2.0 (the "License");
	  you may not use this file except in compliance with the License.
	  You may obtain a copy of the License at

	      http://www.apache.org/licenses/LICENSE-2.0

	  Unless required by applicable law or agreed to in writing, software
	  distributed under the License is distributed on an "AS IS" BASIS,
	  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	  See the License for the specific language governing permissions and
	  limitations under the License.
	*/
	'use strict';

	var globalOptions = __webpack_require__(3);
	var idbCacheExpiration = __webpack_require__(9);

	function debug(message, options) {
	  options = options || {};
	  var flag = options.debug || globalOptions.debug;
	  if (flag) {
	    console.log('[sw-toolbox] ' + message);
	  }
	}

	function openCache(options) {
	  var cacheName;
	  if (options && options.cache) {
	    cacheName = options.cache.name;
	  }
	  cacheName = cacheName || globalOptions.cache.name;

	  return caches.open(cacheName);
	}

	function fetchAndCache(request, options) {
	  options = options || {};
	  var successResponses = options.successResponses ||
	      globalOptions.successResponses;

	  return fetch(request.clone()).then(function(response) {
	    // Only cache GET requests with successful responses.
	    // Since this is not part of the promise chain, it will be done
	    // asynchronously and will not block the response from being returned to the
	    // page.
	    if (request.method === 'GET' && successResponses.test(response.status)) {
	      openCache(options).then(function(cache) {
	        cache.put(request, response).then(function() {
	          // If any of the options are provided in options.cache then use them.
	          // Do not fallback to the global options for any that are missing
	          // unless they are all missing.
	          var cacheOptions = options.cache || globalOptions.cache;

	          // Only run the cache expiration logic if at least one of the maximums
	          // is set, and if we have a name for the cache that the options are
	          // being applied to.
	          if ((cacheOptions.maxEntries || cacheOptions.maxAgeSeconds) &&
	              cacheOptions.name) {
	            queueCacheExpiration(request, cache, cacheOptions);
	          }
	        });
	      });
	    }

	    return response.clone();
	  });
	}

	var cleanupQueue;
	function queueCacheExpiration(request, cache, cacheOptions) {
	  var cleanup = cleanupCache.bind(null, request, cache, cacheOptions);

	  if (cleanupQueue) {
	    cleanupQueue = cleanupQueue.then(cleanup);
	  } else {
	    cleanupQueue = cleanup();
	  }
	}

	function cleanupCache(request, cache, cacheOptions) {
	  var requestUrl = request.url;
	  var maxAgeSeconds = cacheOptions.maxAgeSeconds;
	  var maxEntries = cacheOptions.maxEntries;
	  var cacheName = cacheOptions.name;

	  var now = Date.now();
	  debug('Updating LRU order for ' + requestUrl + '. Max entries is ' +
	    maxEntries + ', max age is ' + maxAgeSeconds);

	  return idbCacheExpiration.getDb(cacheName).then(function(db) {
	    return idbCacheExpiration.setTimestampForUrl(db, requestUrl, now);
	  }).then(function(db) {
	    return idbCacheExpiration.expireEntries(db, maxEntries, maxAgeSeconds, now);
	  }).then(function(urlsToDelete) {
	    debug('Successfully updated IDB.');

	    var deletionPromises = urlsToDelete.map(function(urlToDelete) {
	      return cache.delete(urlToDelete);
	    });

	    return Promise.all(deletionPromises).then(function() {
	      debug('Done with cache cleanup.');
	    });
	  }).catch(function(error) {
	    debug(error);
	  });
	}

	function renameCache(source, destination, options) {
	  debug('Renaming cache: [' + source + '] to [' + destination + ']', options);
	  return caches.delete(destination).then(function() {
	    return Promise.all([
	      caches.open(source),
	      caches.open(destination)
	    ]).then(function(results) {
	      var sourceCache = results[0];
	      var destCache = results[1];

	      return sourceCache.keys().then(function(requests) {
	        return Promise.all(requests.map(function(request) {
	          return sourceCache.match(request).then(function(response) {
	            return destCache.put(request, response);
	          });
	        }));
	      }).then(function() {
	        return caches.delete(source);
	      });
	    });
	  });
	}

	module.exports = {
	  debug: debug,
	  fetchAndCache: fetchAndCache,
	  openCache: openCache,
	  renameCache: renameCache
	};


/***/ },
/* 9 */
/***/ function(module, exports) {

	/*
	 Copyright 2015 Google Inc. All Rights Reserved.

	 Licensed under the Apache License, Version 2.0 (the "License");
	 you may not use this file except in compliance with the License.
	 You may obtain a copy of the License at

	     http://www.apache.org/licenses/LICENSE-2.0

	 Unless required by applicable law or agreed to in writing, software
	 distributed under the License is distributed on an "AS IS" BASIS,
	 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	 See the License for the specific language governing permissions and
	 limitations under the License.
	*/
	'use strict';

	var DB_PREFIX = 'sw-toolbox-';
	var DB_VERSION = 1;
	var STORE_NAME = 'store';
	var URL_PROPERTY = 'url';
	var TIMESTAMP_PROPERTY = 'timestamp';
	var cacheNameToDbPromise = {};

	function openDb(cacheName) {
	  return new Promise(function(resolve, reject) {
	    var request = indexedDB.open(DB_PREFIX + cacheName, DB_VERSION);

	    request.onupgradeneeded = function() {
	      var objectStore = request.result.createObjectStore(STORE_NAME,
	          {keyPath: URL_PROPERTY});
	      objectStore.createIndex(TIMESTAMP_PROPERTY, TIMESTAMP_PROPERTY,
	          {unique: false});
	    };

	    request.onsuccess = function() {
	      resolve(request.result);
	    };

	    request.onerror = function() {
	      reject(request.error);
	    };
	  });
	}

	function getDb(cacheName) {
	  if (!(cacheName in cacheNameToDbPromise)) {
	    cacheNameToDbPromise[cacheName] = openDb(cacheName);
	  }

	  return cacheNameToDbPromise[cacheName];
	}

	function setTimestampForUrl(db, url, now) {
	  return new Promise(function(resolve, reject) {
	    var transaction = db.transaction(STORE_NAME, 'readwrite');
	    var objectStore = transaction.objectStore(STORE_NAME);
	    objectStore.put({url: url, timestamp: now});

	    transaction.oncomplete = function() {
	      resolve(db);
	    };

	    transaction.onabort = function() {
	      reject(transaction.error);
	    };
	  });
	}

	function expireOldEntries(db, maxAgeSeconds, now) {
	  // Bail out early by resolving with an empty array if we're not using
	  // maxAgeSeconds.
	  if (!maxAgeSeconds) {
	    return Promise.resolve([]);
	  }

	  return new Promise(function(resolve, reject) {
	    var maxAgeMillis = maxAgeSeconds * 1000;
	    var urls = [];

	    var transaction = db.transaction(STORE_NAME, 'readwrite');
	    var objectStore = transaction.objectStore(STORE_NAME);
	    var index = objectStore.index(TIMESTAMP_PROPERTY);

	    index.openCursor().onsuccess = function(cursorEvent) {
	      var cursor = cursorEvent.target.result;
	      if (cursor) {
	        if (now - maxAgeMillis > cursor.value[TIMESTAMP_PROPERTY]) {
	          var url = cursor.value[URL_PROPERTY];
	          urls.push(url);
	          objectStore.delete(url);
	          cursor.continue();
	        }
	      }
	    };

	    transaction.oncomplete = function() {
	      resolve(urls);
	    };

	    transaction.onabort = reject;
	  });
	}

	function expireExtraEntries(db, maxEntries) {
	  // Bail out early by resolving with an empty array if we're not using
	  // maxEntries.
	  if (!maxEntries) {
	    return Promise.resolve([]);
	  }

	  return new Promise(function(resolve, reject) {
	    var urls = [];

	    var transaction = db.transaction(STORE_NAME, 'readwrite');
	    var objectStore = transaction.objectStore(STORE_NAME);
	    var index = objectStore.index(TIMESTAMP_PROPERTY);

	    var countRequest = index.count();
	    index.count().onsuccess = function() {
	      var initialCount = countRequest.result;

	      if (initialCount > maxEntries) {
	        index.openCursor().onsuccess = function(cursorEvent) {
	          var cursor = cursorEvent.target.result;
	          if (cursor) {
	            var url = cursor.value[URL_PROPERTY];
	            urls.push(url);
	            objectStore.delete(url);
	            if (initialCount - urls.length > maxEntries) {
	              cursor.continue();
	            }
	          }
	        };
	      }
	    };

	    transaction.oncomplete = function() {
	      resolve(urls);
	    };

	    transaction.onabort = reject;
	  });
	}

	function expireEntries(db, maxEntries, maxAgeSeconds, now) {
	  return expireOldEntries(db, maxAgeSeconds, now).then(function(oldUrls) {
	    return expireExtraEntries(db, maxEntries).then(function(extraUrls) {
	      return oldUrls.concat(extraUrls);
	    });
	  });
	}

	module.exports = {
	  getDb: getDb,
	  setTimestampForUrl: setTimestampForUrl,
	  expireEntries: expireEntries
	};


/***/ },
/* 10 */
/***/ function(module, exports, __webpack_require__) {

	/*
		Copyright 2014 Google Inc. All Rights Reserved.

		Licensed under the Apache License, Version 2.0 (the "License");
		you may not use this file except in compliance with the License.
		You may obtain a copy of the License at

	      http://www.apache.org/licenses/LICENSE-2.0

		Unless required by applicable law or agreed to in writing, software
		distributed under the License is distributed on an "AS IS" BASIS,
		WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
		See the License for the specific language governing permissions and
		limitations under the License.
	*/
	module.exports = {
	  networkOnly: __webpack_require__(11),
	  networkFirst: __webpack_require__(12),
	  cacheOnly: __webpack_require__(13),
	  cacheFirst: __webpack_require__(14),
	  fastest: __webpack_require__(15)
	};


/***/ },
/* 11 */
/***/ function(module, exports, __webpack_require__) {

	/*
		Copyright 2014 Google Inc. All Rights Reserved.

		Licensed under the Apache License, Version 2.0 (the "License");
		you may not use this file except in compliance with the License.
		You may obtain a copy of the License at

	      http://www.apache.org/licenses/LICENSE-2.0

		Unless required by applicable law or agreed to in writing, software
		distributed under the License is distributed on an "AS IS" BASIS,
		WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
		See the License for the specific language governing permissions and
		limitations under the License.
	*/
	'use strict';
	var helpers = __webpack_require__(8);

	function networkOnly(request, values, options) {
	  helpers.debug('Strategy: network only [' + request.url + ']', options);
	  return fetch(request);
	}

	module.exports = networkOnly;


/***/ },
/* 12 */
/***/ function(module, exports, __webpack_require__) {

	/*
	 Copyright 2015 Google Inc. All Rights Reserved.

	 Licensed under the Apache License, Version 2.0 (the "License");
	 you may not use this file except in compliance with the License.
	 You may obtain a copy of the License at

	     http://www.apache.org/licenses/LICENSE-2.0

	 Unless required by applicable law or agreed to in writing, software
	 distributed under the License is distributed on an "AS IS" BASIS,
	 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	 See the License for the specific language governing permissions and
	 limitations under the License.
	*/
	'use strict';
	var globalOptions = __webpack_require__(3);
	var helpers = __webpack_require__(8);

	function networkFirst(request, values, options) {
	  options = options || {};
	  var successResponses = options.successResponses ||
	      globalOptions.successResponses;
	  // This will bypass options.networkTimeout if it's set to a false-y value like
	  // 0, but that's the sane thing to do anyway.
	  var networkTimeoutSeconds = options.networkTimeoutSeconds ||
	      globalOptions.networkTimeoutSeconds;
	  helpers.debug('Strategy: network first [' + request.url + ']', options);

	  return helpers.openCache(options).then(function(cache) {
	    var timeoutId;
	    var promises = [];
	    var originalResponse;

	    if (networkTimeoutSeconds) {
	      var cacheWhenTimedOutPromise = new Promise(function(resolve) {
	        timeoutId = setTimeout(function() {
	          cache.match(request).then(function(response) {
	            if (response) {
	              // Only resolve this promise if there's a valid response in the
	              // cache. This ensures that we won't time out a network request
	              // unless there's a cached entry to fallback on, which is arguably
	              // the preferable behavior.
	              resolve(response);
	            }
	          });
	        }, networkTimeoutSeconds * 1000);
	      });
	      promises.push(cacheWhenTimedOutPromise);
	    }

	    var networkPromise = helpers.fetchAndCache(request, options)
	      .then(function(response) {
	        // We've got a response, so clear the network timeout if there is one.
	        if (timeoutId) {
	          clearTimeout(timeoutId);
	        }

	        if (successResponses.test(response.status)) {
	          return response;
	        }

	        helpers.debug('Response was an HTTP error: ' + response.statusText,
	            options);
	        originalResponse = response;
	        throw new Error('Bad response');
	      }).catch(function(error) {
	        helpers.debug('Network or response error, fallback to cache [' +
	            request.url + ']', options);
	        return cache.match(request).then(function(response) {
	          // If there's a match in the cache, resolve with that.
	          if (response) {
	            return response;
	          }

	          // If we have a Response object from the previous fetch, then resolve
	          // with that, even though it corresponds to an error status code.
	          if (originalResponse) {
	            return originalResponse;
	          }

	          // If we don't have a Response object from the previous fetch, likely
	          // due to a network failure, then reject with the failure error.
	          throw error;
	        });
	      });

	    promises.push(networkPromise);

	    return Promise.race(promises);
	  });
	}

	module.exports = networkFirst;


/***/ },
/* 13 */
/***/ function(module, exports, __webpack_require__) {

	/*
		Copyright 2014 Google Inc. All Rights Reserved.

		Licensed under the Apache License, Version 2.0 (the "License");
		you may not use this file except in compliance with the License.
		You may obtain a copy of the License at

	      http://www.apache.org/licenses/LICENSE-2.0

		Unless required by applicable law or agreed to in writing, software
		distributed under the License is distributed on an "AS IS" BASIS,
		WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
		See the License for the specific language governing permissions and
		limitations under the License.
	*/
	'use strict';
	var helpers = __webpack_require__(8);

	function cacheOnly(request, values, options) {
	  helpers.debug('Strategy: cache only [' + request.url + ']', options);
	  return helpers.openCache(options).then(function(cache) {
	    return cache.match(request);
	  });
	}

	module.exports = cacheOnly;


/***/ },
/* 14 */
/***/ function(module, exports, __webpack_require__) {

	/*
		Copyright 2014 Google Inc. All Rights Reserved.

		Licensed under the Apache License, Version 2.0 (the "License");
		you may not use this file except in compliance with the License.
		You may obtain a copy of the License at

	      http://www.apache.org/licenses/LICENSE-2.0

		Unless required by applicable law or agreed to in writing, software
		distributed under the License is distributed on an "AS IS" BASIS,
		WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
		See the License for the specific language governing permissions and
		limitations under the License.
	*/
	'use strict';
	var helpers = __webpack_require__(8);

	function cacheFirst(request, values, options) {
	  helpers.debug('Strategy: cache first [' + request.url + ']', options);
	  return helpers.openCache(options).then(function(cache) {
	    return cache.match(request).then(function(response) {
	      if (response) {
	        return response;
	      }

	      return helpers.fetchAndCache(request, options);
	    });
	  });
	}

	module.exports = cacheFirst;


/***/ },
/* 15 */
/***/ function(module, exports, __webpack_require__) {

	/*
	  Copyright 2014 Google Inc. All Rights Reserved.

	  Licensed under the Apache License, Version 2.0 (the "License");
	  you may not use this file except in compliance with the License.
	  You may obtain a copy of the License at

	      http://www.apache.org/licenses/LICENSE-2.0

	  Unless required by applicable law or agreed to in writing, software
	  distributed under the License is distributed on an "AS IS" BASIS,
	  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	  See the License for the specific language governing permissions and
	  limitations under the License.
	*/
	'use strict';
	var helpers = __webpack_require__(8);
	var cacheOnly = __webpack_require__(13);

	function fastest(request, values, options) {
	  helpers.debug('Strategy: fastest [' + request.url + ']', options);

	  return new Promise(function(resolve, reject) {
	    var rejected = false;
	    var reasons = [];

	    var maybeReject = function(reason) {
	      reasons.push(reason.toString());
	      if (rejected) {
	        reject(new Error('Both cache and network failed: "' +
	            reasons.join('", "') + '"'));
	      } else {
	        rejected = true;
	      }
	    };

	    var maybeResolve = function(result) {
	      if (result instanceof Response) {
	        resolve(result);
	      } else {
	        maybeReject('No result returned');
	      }
	    };

	    helpers.fetchAndCache(request.clone(), options)
	      .then(maybeResolve, maybeReject);

	    cacheOnly(request, values, options)
	      .then(maybeResolve, maybeReject);
	  });
	}

	module.exports = fastest;


/***/ },
/* 16 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	const streamUtil = __webpack_require__(17);
	const parseCSSSelector = __webpack_require__(18);

	// Shared patterns
	const optionalAttributePattern = '(?:\\s+[a-zA-Z_-]+(?:=(?:"[^"]*"|\'[^\']*\'))?)*';
	const remainingTagAssertionPattern = `(?=${optionalAttributePattern}\\s*\\/?>)`;
	const remainingTagCloseCapturePattern = `${optionalAttributePattern}\\s*(\\/?)>`;
	const remainingTagPattern = `${optionalAttributePattern}\\s*\\/?>`;
	const ANY_TAG = new RegExp(`<(\/?)([a-zA-Z][a-zA-Z0-9_-]*)${remainingTagCloseCapturePattern}`, 'g');

	// https://www.w3.org/TR/html-markup/syntax.html#syntax-attributes:
	// Attribute names must consist of one or more characters other than the space
	// characters, U+0000 NULL, """, "'", ">", "/", "=", the control characters,
	// and any characters that are not defined by Unicode.
	const ATTRIB_NAME_PATTERN = '[^\\s\\0"\'>/=\x00-\x1F\x7F-\x9F]+';
	const ATTRIB_PATTERN = `\\s+(${ATTRIB_NAME_PATTERN})=(?:"([^"]*)"|'([^']*)')|`;
	const ATTRIB = new RegExp(ATTRIB_PATTERN, 'g');
	const TAG_END = new RegExp('\\s*\/?>|', 'g');

	function escapeRegex(re) {
	    return re.replace(/[\^\\$*+?.()|{}\[\]\/]/g, '\\$&');
	}

	const attrValReplacements = {
	    'double': {
	        '<': '(?:<|&lt;)',
	        '>': '(?:>|&gt;)',
	        '&': '(?&|&amp;)',
	        '"': '&quot;',
	        "'": '(?:\'|&apos;|&#39;)',
	    }
	};
	attrValReplacements.single = Object.assign({},
	    attrValReplacements.double, {
	        '"': '(?:"|&quot;)',
	        "'": '(?:\'|&apos;|&#39;)',
	    });

	// Entity decoding. We only support the small set of entities actually used by
	// HTML5 serialized as UTF8.
	const entityDecodeMap = {
	    '&amp;': '&',
	    '&quot;': '"',
	    '&#39;': "'",
	    '&lt;': '<',
	    '&gt;': '>',
	};
	function decodeEntities(s) {
	    return s.replace(/&[#a-zA-Z0-9]+;/g, function(match) {
	        const decoded = entityDecodeMap[match];
	        if (!decoded) {
	           throw new Error("Unsupported entity: " + match);
	        }
	        return decoded;
	    });
	}


	/**
	 * Element matcher.
	 */
	class HTMLTransformReader {

	     /* Construct a Matcher instance.
	      *
	      * @param {array|Matcher} spec. One of:
	      *   1) An array of rule definitions:
	      *      - A `selector` {object} definition, containing
	      *        - a `nodeName` {string}, and (optionally)
	      *        - `attributes, an array of attribute match definitions:
	      *           - `name`: The attribute name.
	      *           - `operator`: One of "=", "^=" etc.
	      *           - `value`: Expected attribute value or pattern.
	      *      - A `handler`, function(node, ctx)
	      *      - Optionally, a `stream` boolean. When set, the handler is passed
	      *      `innerHTML` and `outerHTML` as a `ReadableStream` instance.
	      *   2) A Matcher instance. In this case, the spec & pre-compiled
	      *      matchers of that instance are reused, which is significantly more
	      *      efficient. Match state and options are unique to the new
	      *      instance.
	      * @param {object} options (optional)
	      *      - {boolean} matchOnly (optional): Only include matches in the values; drop
	      *      unmatched content.
	      *      - {object} ctx (optional): A context object passed to handlers.
	      */
	    constructor(input, options) {
	        this._rawInput = input;
	        this._reader = streamUtil.toReader(input);
	        this._options = options || {};
	        this._transforms = this._options.transforms;
	        this._closed = false;
	        this._matchedSome = false;
	        if (!this._transforms) {
	            throw new Error("No spec supplied!");
	        }
	        this._re = {};
	        if (this._transforms._cache) {
	            this._re = this._transforms._cache;
	        } else {
	            this._normalizeTransforms();
	            this._makeMatchers(this._transforms);
	            // Efficient matcher for random Tags.
	            this._transforms._cache = this._re;
	        }
	        this._reset();
	    }

	    _normalizeTransforms() {
	        // Convert spec to a Matcher spec.
	        this._transforms.forEach(rule => {
	            if (typeof rule.selector === 'string') {
	                rule.selector = parseCSSSelector(rule.selector);
	            }
	        });
	    }

	    _reset() {
	        // Reset match state.
	        this._activeMatcher = null;
	        this._activeMatcherArgs = null;
	        this._buffer = '';
	        this._lastIndex = 0;
	        this._matches = [];
	    }

	    cancel() {
	        this._reset();
	        if (this._reader && this._reader.cancel) {
	           this._reader.cancel();
	        }
	    }

	    read() {
	        return this._reader.read()
	        .then(res => {
	            if (res.done) {
	                if (this._matches.length) {
	                    const matches = this._matches;
	                    this._matches = [];
	                    return {
	                        value: matches,
	                        done: false
	                    };
	                }
	                if (this._buffer) {
	                    const e = new Error("Incomplete match. Remaining: " + this._buffer.slice(0,100));
	                    this._reset();
	                    throw e;
	                }
	                this._closed = true;
	                return res;
	            }
	            const matchRes = this._match(res.value);
	            if (!matchRes.done && matchRes.value.length === 0) {
	                // Read some more until we can return something.
	                return this.read();
	            }
	            if (matchRes.done && matchRes.value.length) {
	                matchRes.done = false;
	            }
	            return matchRes;
	        });
	    }

	    drainSync() {
	        if (typeof this._rawInput !== 'string') {
	            throw new Error("drainSync() is only supported for plain string inputs!");
	        }
	        this._closed = true;
	        const res = this._match(this._rawInput);
	        if (!res.done) {
	            this._reset();
	            throw new Error("Incomplete match.");
	        }
	        return res.value;
	    }

	    /**
	     * Pull from sub-streams. These don't directly return matches, but push
	     * matched chunks to sub-streams for elements.
	     */
	    _pull(controller) {
	        return this._reader.read()
	            .then(res => {
	                if (res.done) {
	                    this._closed = true;
	                    return;
	                }
	                // ElementMatch enqueue / close happens
	                // implicitly as part of recursive call.
	                this._matches = this._matches.concat(this._match(res.value).value);
	                if (!this._matchedSome && !this._matches.length && !controller._isClosed) {
	                    return this._pull(controller);
	                }
	            });
	    }

	    /**
	     * Match a document, a chunk at a time.
	     *
	     * @param {string} chunk
	     * @return {object}
	     *   - {array<string|mixed>} value, an array of literal strings
	     *   interspersed with handler return values for matches.
	     *   - {boolean} done, whether the matcher has matched a complete
	     *   document.
	     */
	    _match(chunk) {
	        const re = this._re;
	        this._buffer += chunk;
	        this._lastIndex = 0;
	        this._matchedSome = false;

	        // Main document parse loop.
	        let prevIndex;
	        do {
	            prevIndex = this._lastIndex;
	            if (!this._activeMatcher) {
	                // Explicitly match tags & attributes to avoid matching literal
	                // `<` in attribute values. These are escaped with `&lt;` in XML,
	                // but not HTML5.
	                re.nonTargetStartTag.lastIndex = this._lastIndex;
	                re.nonTargetStartTag.exec(this._buffer);
	                if (re.nonTargetStartTag.lastIndex !== this._lastIndex) {
	                    // Matched some content.
	                    if (!this._options.matchOnly) {
	                        this._matchedSome = true;
	                        // Add to matches.
	                        this._matches.push(this._buffer.slice(this._lastIndex,
	                            re.nonTargetStartTag.lastIndex));
	                    }
	                    this._lastIndex = re.nonTargetStartTag.lastIndex;
	                }
	                if (re.nonTargetStartTag.lastIndex === this._buffer.length) {
	                    // All done.
	                    this._lastIndex = 0;
	                    this._buffer = '';
	                    break;
	                }
	                this._activeMatcherArgs = null;
	                prevIndex = this._lastIndex;
	            }

	            this._matchElement();
	        } while (this._lastIndex !== prevIndex);

	        const matches = this._matches;
	        this._matches = [];
	        return {
	            value: matches,
	            // Normally we should not return done when there were still
	            // matches, but we fix that up in read(). Doing it this way
	            // simplifies synchronous matching with drainSync().
	            done: !this._buffer && this._closed
	        };
	    }

	    _matchTagEnd() {
	        TAG_END.lastIndex = this._lastIndex;
	        TAG_END.exec(this._buffer);
	        this._lastIndex = TAG_END.lastIndex;
	    }

	    _matchElement() {
	        let args = this._activeMatcherArgs;
	        const re = this._re;
	        if (!args) {
	            // First call.
	            re.targetTag.lastIndex = this._lastIndex;

	            // TODO: Move this to matchElement!
	            // Try to match a target tag.
	            const targetMatch = re.targetTag.exec(this._buffer);
	            // Match the remainder of the element.

	            if (!targetMatch) {
	                // Can't match a targetTag yet. Wait for more input.
	                this._buffer = this._buffer.slice(this._lastIndex);
	                this._lastIndex = 0;
	                return;
	            }

	            this._activeMatcher = this._matchElement;
	            this._lastIndex = re.targetTag.lastIndex;

	            if (!targetMatch[1]) {
	                // Start tag.

	                // The attribute match is guaranteed to complete, as our targetTag
	                // regexp asserts that the entire tag (incl attributes) is
	                // available.
	                const attributes = this._matchAttributes();
	                // Consume the tag end & update this._lastIndex
	                this._matchTagEnd();

	                // Set up elementMatcherArgs
	                this._activeMatcherArgs = args = {};
	                // Look up the handler matching the selector, by group index.
	                for (let i = 2; i < targetMatch.length; i++) {
	                    let tagMatch = targetMatch[i];
	                    if (tagMatch !== undefined) {
	                        args.rule = this._transforms[i-2];
	                        break;
	                    }
	                }
	                args.node = {
	                    nodeName: args.rule.selector.nodeName,
	                    attributes,
	                    outerHTML: this._buffer.slice(re.nonTargetStartTag.lastIndex, this._lastIndex),
	                    innerHTML: '',
	                };
	                if (args.rule.stream) {
	                    args.node.outerHTML = new ReadableStream({
	                        start: controller => {
	                            controller.enqueue(args.node.outerHTML);
	                            args.outerHTMLController = controller;
	                        },
	                        pull: controller => this._pull(controller)
	                    });
	                    args.node.innerHTML = new ReadableStream({
	                        start: controller => {
	                            args.innerHTMLController = controller;
	                        },
	                        pull: controller => this._pull(controller)
	                    });
	                    // Call the handler
	                    this._matches.push(args.rule.handler(args.node, this._options.ctx));
	                }
	                args.depth = 1;
	            } else {
	                throw new Error("Stray end tag!");
	            }
	        }

	        re.anyTag.lastIndex = this._lastIndex;

	        while (true) {
	            let lastAnyIndex = re.anyTag.lastIndex;
	            // Efficiently skip over tags we aren't interested in.
	            re.otherTag.lastIndex = lastAnyIndex;
	            re.otherTag.exec(this._buffer);
	            if (re.otherTag.lastIndex > lastAnyIndex) {
	                lastAnyIndex = re.otherTag.lastIndex;
	                re.anyTag.lastIndex = re.otherTag.lastIndex;
	            }
	            // Inspect the next (potentially interesting) tag more closely.
	            const match = re.anyTag.exec(this._buffer);
	            if (!match) {
	                // Can't complete a match.
	                if (lastAnyIndex) {
	                    // Matched *some* content.
	                    this._matchedSome = true;
	                    if (args.rule.stream) {
	                        const chunk = this._buffer.substring(this._lastIndex,
	                            lastAnyIndex);
	                        args.outerHTMLController.enqueue(chunk);
	                        args.innerHTMLController.enqueue(chunk);
	                        this._buffer = this._buffer.slice(lastAnyIndex);
	                        this._lastIndex = 0;
	                    } else {
	                        // Hold onto the entire input for the element.
	                        this._buffer = this._buffer.slice(this._lastIndex);
	                        this._lastIndex = 0;
	                    }
	                    return;
	                } else {
	                    // Repeat read until we can return a chunk.
	                    this.read().then(res => {
	                        if (!res.done) {
	                            this._matches = this._matches.concat(res.value);
	                        }
	                    });
	                    return;
	                }
	            }

	            if (match[2] === args.rule.selector.nodeName) {
	                if (match[1]) {
	                    // End tag
	                    args.depth--;
	                    if (args.depth === 0) {
	                        this._matchedSome = true;
	                        const outerChunk = this._buffer.substring(this._lastIndex,
	                                re.anyTag.lastIndex);
	                        const innerChunk = this._buffer.substring(this._lastIndex, match.index);
	                        if (args.rule.stream) {
	                            args.outerHTMLController.enqueue(outerChunk);
	                            args.outerHTMLController.close();
	                            args.outerHTMLController._isClosed = true;
	                            args.innerHTMLController.enqueue(innerChunk);
	                            args.innerHTMLController.close();
	                            args.innerHTMLController._isClosed = true;
	                        } else {
	                            args.node.outerHTML += outerChunk;
	                            args.node.innerHTML += innerChunk;
	                            // Call the handler
	                            this._matches.push(args.rule.handler(args.node, this._options.ctx));
	                        }

	                        this._lastIndex = re.anyTag.lastIndex;
	                        this._activeMatcher = null;
	                        this._activeMatcherArgs = null;
	                        return;
	                    }
	                } else if (!match[3]) {
	                    // Start tag.
	                    args.depth++;
	                }
	            }
	        }
	    }

	    _matchAttributes() {

	        ATTRIB.lastIndex = this._lastIndex;
	        const attributes = {};
	        while (true) {
	            const match = ATTRIB.exec(this._buffer);
	            if (match[0].length === 0) {
	                break;
	            }
	            let val = match[2] || match[3];
	            if (val.indexOf('&') !== -1) {
	                // Decode HTML entities
	                val = decodeEntities(val);
	            }
	            attributes[match[1]] = val;
	        }
	        this._lastIndex = ATTRIB.lastIndex;
	        return attributes;
	    }

	    _makeMatchers(spec) {
	        const self = this;
	        this.lastIndex = 0;
	        // Need:
	        // - Start tag matcher. Safe, as '<' is always escaped, including
	        // attributes.
	        // - Random tag matcher. Match as long as level reaches zero.


	        const tagMatchPatterns = spec
	            .map(rule => self._compileTagMatcher(rule.selector));

	        const commentMatchPattern = '!--[\\s\\S]*?-->';

	        // A matcher for the tags we are *not* interested in. Used in HTML5 mode.
	        this._re.nonTargetStartTag = new RegExp(`[^<]*(?:<(?:[\\/! ]*(?!${tagMatchPatterns
	        .map(pattern => '(?:' + pattern + ')')
	        .join('|')})[a-zA-Z][a-zA-Z0-9_-]*${remainingTagPattern}|${commentMatchPattern})[^<]*)*`, 'g');

	        const nodeNames = new Set();
	        spec.forEach(rule => nodeNames.add(rule.selector.nodeName));
	        const nodeNameRe = Array.from(nodeNames.keys()).join('|');

	        this._re.otherTag = new RegExp(`[^<]*(?:<(?:[\\/!\s]*(?!${nodeNameRe})[a-zA-Z][a-zA-Z0-9_-]*${remainingTagPattern}|${commentMatchPattern})[^<]*)+|`, 'g');

	        // A matcher for the tags we *are* actually interested in.
	        this._re.targetTag = new RegExp(`<(\\/?)(?:${tagMatchPatterns
	        .map(pattern => '(' + pattern + ')')
	        .join('|')})${remainingTagAssertionPattern}`, 'g');

	        this._re.anyTag = ANY_TAG;
	    }

	    _quoteAttributeValue(s, mode) {
	        if (/[<'">&]/.test(s)) {
	            const map = attrValReplacements[mode];
	            // Escape any regexp chars in the value
	            s = escapeRegex(s);
	            return s.replace(/[<'">&]/g, m => map[m]);
	        } else {
	            return s;
	        }
	    }

	    _compileTagMatcher(selector) {
	        if (!selector.nodeName) {
	            throw new Error("Only matches for fixed tag names are supported for now!");
	        }
	        const attributes = selector.attributes;
	        let res = selector.nodeName || '';
	        if (attributes && attributes.length) {
	            if (attributes.length > 1) {
	                throw new Error("Only a single attribute match is supported for now!");
	            }
	            const attributeSelector = attributes[0];
	            // Only match on the first attribute
	            const attr = {
	                name: attributeSelector[0],
	                operator: attributeSelector[1],
	                value: attributeSelector[2]
	            };

	            res += `(?=[^>]*?\\s${attr.name}`;
	            const doubleQuoteValuePattern = this._quoteAttributeValue(attr.value, 'double');
	            const singleQuoteValuePattern = this._quoteAttributeValue(attr.value, 'single');
	            if (!attr.operator) {
	                 res += '=(?:"[^"]*"|\'[^\']*\'))';
	            } else if (attr.operator === '=') {
	                res += `=(?:"${doubleQuoteValuePattern}"|'${singleQuoteValuePattern}'))`;
	            } else if (attr.operator === '^=') {
	                res += `=(?:"${doubleQuoteValuePattern}[^"]*"|'${singleQuoteValuePattern}[^']*'))`;
	            } else if (attr.operator === '$=') {
	                res += `=(?:"[^"]*${doubleQuoteValuePattern}"|'[^']*${singleQuoteValuePattern}'))`;
	            } else if (attr.operator === '~=') {
	                res += `=(?:"(?:[^"]+\\s+)*${doubleQuoteValuePattern}(?:\\s+[^"]+)*"|'(?:[^']+\\s)*${singleQuoteValuePattern}(?:\\s[^']+)*'))`;
	            } else if (attr.operator === '*=') {
	                res += `=(?:"[^"]*${doubleQuoteValuePattern}[^"]*"|'[^']*${singleQuoteValuePattern}[^']*'))`;
	            } else {
	                throw new Error(`Unsupported attribute predicate: ${attr.operator}`);
	            }
	        }
	        return res;
	    }
	}

	module.exports = {
	    HTMLTransformReader: HTMLTransformReader,
	};


/***/ },
/* 17 */
/***/ function(module, exports) {

	'use strict';

	// Helper to make returns monomorphic.
	function readerReturn(value, done) {
	    return {
	        value: value,
	        done: done,
	    };
	}

	/**
	 * ReadableStream wrapping an array.
	 *
	 * @param {Array} arr, the array to wrap into a stream.
	 * @return {ReadableStream}
	 */
	function arrayToStream(arr) {
	    return new ReadableStream({
	        start(controller) {
	            for (var i = 0; i < arr.length; i++) {
	                controller.enqueue(arr[i]);
	            }
	            controller.close();
	        }
	    });
	}

	class ArrayReader {
	    constructor(arr) {
	        this._arr = arr;
	        this._index = 0;
	    }
	    read() {
	        if (this._index < this._arr.length) {
	            return Promise.resolve(readerReturn(this._arr[this._index++], false));
	        } else {
	            return Promise.resolve(readerReturn(undefined, true));
	        }
	    }
	    cancel() {
	        this._offset = -1;
	    }
	}

	/**
	 * Chunk evaluation transform:
	 * - functions are called with ctx parameter,
	 * - Promises are resolved to a value,
	 * - ReadableStreams are spliced into the main string, and
	 * - all other types are passed through unchanged.
	 *
	 * @param {object} ctx, a context object passed to function chunks.
	 * @return {function(Reader) -> Reader}
	 */
	class FlatStreamReader {
	    constructor(input, ctx) {
	        this._reader = toReader(input);
	        this._ctx = ctx;
	        this._subStreamReader = null;
	    }

	    _handleReadRes(res) {
	        if (res.done) {
	            return res;
	        }

	        let chunk = res.value;
	        // Fast path
	        if (typeof chunk === 'string') {
	            return res;
	        }
	        if (typeof chunk === 'function') {
	            chunk = chunk(this._ctx);
	        }
	        if (chunk) {
	            if (Array.isArray(chunk)) {
	                this._subStreamReader = new ArrayReader(chunk);
	                return this.read();
	            }
	            if (typeof chunk.then === 'function') {
	                // Looks like a Promise.
	                return chunk.then(val => {
	                    res.value = val;
	                    return this._handleReadRes(res);
	                });
	            }
	            if (typeof chunk.getReader === 'function') {
	                // Is a ReadableStream. Test based on
	                // IsReadableStream in reference
	                // implementation.
	                this._subStreamReader = chunk.getReader();
	                return this.read();
	            }
	        }
	        res.value = chunk;
	        return res;
	    }

	    read() {
	        let readPromise;
	        if (this._subStreamReader) {
	            return this._subStreamReader.read()
	            .then(res => {
	                if (res.done) {
	                    this._subStreamReader = null;
	                    return this.read();
	                }
	                return this._handleReadRes(res);
	            });
	        } else {
	            return this._reader.read().then(res => this._handleReadRes(res));
	        }
	    }

	    cancel(reason) {
	        if (this._subStreamReader) {
	            this._subStreamReader.cancel(reason);
	        }
	        return this._reader.cancel && this._reader.cancel(reason);
	    }
	}

	/**
	 * Adapt a Reader to an UnderlyingSource, for wrapping into a ReadableStream.
	 *
	 * @param {Reader} reader
	 * @return {ReadableStream}
	 */
	function readerToStream(reader) {
	    return new ReadableStream({
	        pull: controller => {
	            return reader.read()
	                .then(res => {
	                    if (res.done) {
	                        controller.close();
	                    } else {
	                        controller.enqueue(res.value);
	                    }
	                });
	        },
	        cancel: reason => reader.cancel(reason)
	    });
	}

	function toReader(s) {
	    if (s) {
	        if (typeof s.read === 'function') {
	            // Looks like a Reader.
	            return s;
	        }
	        if (typeof s.getReader === 'function') {
	            // ReadableStream
	            return s.getReader();
	        }
	        if (Array.isArray(s)) {
	            return new ArrayReader(s);
	        }
	    }
	    return new ArrayReader([s]);
	}

	function toStream(s) {
	    if (s) {
	        if (typeof s.getReader === 'function') {
	            // Already a ReadableStream
	            return s;
	        }
	        if (Array.isArray(s)) {
	            return arrayToStream(s);
	        }
	        if (typeof s.read === 'function') {
	            // Reader
	            return readerToStream(s);
	        }
	    }
	    return arrayToStream([s]);
	}

	function readToArray(s) {
	    const reader = toReader(s);
	    const accum = [];
	    function pump() {
	        return reader.read()
	        .then(res => {
	            if (res.done) {
	                return accum;
	            }
	            accum.push(res.value);
	            return pump();
	        });
	    }
	    return pump();
	}

	function readToString(s) {
	    const reader = toReader(s);
	    let accum = '';
	    function pump() {
	        return reader.read()
	        .then(res => {
	            if (res.done) {
	                return accum;
	            }
	            accum += res.value;
	            return pump();
	        });
	    }
	    return pump();
	}

	module.exports = {
	    // Utilities
	    toReader: toReader,
	    toStream: toStream,
	    readToArray: readToArray,
	    readToString: readToString,
	    // Chunk evaluation
	    FlatStreamReader: FlatStreamReader,
	};


/***/ },
/* 18 */
/***/ function(module, exports) {

	'use strict';

	const SELECTOR_RE = /^\s*([^\[\s]+)\s*(?:\[\s*([^=\^*~\$\s]+)\s*(?:([\^\$~\*]?=)\s*"([^\]]*)"\s*)?\])?\s*$/;

	const valueDecodeTable = {
	    'n': '\n',
	    'r': '\r',
	    't': '\t',
	    'f': '\f',
	    '"': '"',
	    '\\': '\\'
	};


	/**
	 * Simple CSS selector parser.
	 *
	 * Limitations:
	 * - Only supports single attribute selector.
	 */
	function parseCSSSelector(selector) {
	    const match = SELECTOR_RE.exec(selector);
	    if (!match) {
	        throw new Error("Unsupported or invalid CSS selector: " + selector);
	    }
	    const res = { nodeName: match[1].trim() };
	    if (match[2]) {
	        const attr = [match[2]];
	        if (match[3]) { attr.push(match[3]); }
	        // Decode the attribute value
	        if(match[4]) {
	            attr.push(match[4].replace(/\\([nrtf"\\])/g, function(_, k) {
	                return valueDecodeTable[k];
	            }));
	        }
	        res.attributes = [attr];
	    }
	    return res;
	}

	module.exports = parseCSSSelector;


/***/ },
/* 19 */
/***/ function(module, exports) {

	'use strict';

	// Helper to make returns monomorphic.
	function readerReturn(value, done) {
	    return {
	        value: value,
	        done: done,
	    };
	}

	/**
	 * ReadableStream wrapping an array.
	 *
	 * @param {Array} arr, the array to wrap into a stream.
	 * @return {ReadableStream}
	 */
	function arrayToStream(arr) {
	    return new ReadableStream({
	        start(controller) {
	            for (var i = 0; i < arr.length; i++) {
	                controller.enqueue(arr[i]);
	            }
	            controller.close();
	        }
	    });
	}

	class ArrayReader {
	    constructor(arr) {
	        this._arr = arr;
	        this._index = 0;
	    }
	    read() {
	        if (this._index < this._arr.length) {
	            return Promise.resolve(readerReturn(this._arr[this._index++], false));
	        } else {
	            return Promise.resolve(readerReturn(undefined, true));
	        }
	    }
	    cancel() {
	        this._offset = -1;
	    }
	}

	/**
	 * Chunk evaluation transform:
	 * - functions are called with ctx parameter,
	 * - Promises are resolved to a value,
	 * - ReadableStreams are spliced into the main string, and
	 * - all other types are passed through unchanged.
	 *
	 * @param {object} ctx, a context object passed to function chunks.
	 * @return {function(Reader) -> Reader}
	 */
	class FlatStreamReader {
	    constructor(input, ctx) {
	        this._reader = toReader(input);
	        this._ctx = ctx;
	        this._subStreamReaderStack = [];
	    }

	    _handleReadRes(res) {
	        if (res.done) {
	            return res;
	        }

	        let chunk = res.value;
	        // Fast path
	        if (typeof chunk === 'string') {
	            return res;
	        }
	        if (typeof chunk === 'function') {
	            chunk = chunk(this._ctx);
	        }
	        if (chunk) {
	            if (Array.isArray(chunk)) {
	                this._subStreamReaderStack.push(new ArrayReader(chunk));
	                return this.read();
	            }
	            if (typeof chunk.then === 'function') {
	                // Looks like a Promise.
	                return chunk.then(val => {
	                    res.value = val;
	                    return this._handleReadRes(res);
	                });
	            }
	            if (typeof chunk.read === 'function') {
	                // Reader.
	                this._subStreamReaderStack.push(chunk);
	                return this.read();
	            }
	            if (typeof chunk.getReader === 'function') {
	                // ReadableStream.
	                this._subStreamReaderStack.push(chunk.getReader());
	                return this.read();
	            }
	        }
	        res.value = chunk;
	        return res;
	    }

	    read() {
	        if (this._subStreamReaderStack.length) {
	            return this._subStreamReaderStack[this._subStreamReaderStack.length - 1].read()
	            .then(res => {
	                if (res.done) {
	                    this._subStreamReaderStack.pop();
	                    return this.read();
	                }
	                return this._handleReadRes(res);
	            });
	        } else {
	            return this._reader.read().then(res => this._handleReadRes(res));
	        }
	    }

	    cancel(reason) {
	        if (this._subStreamReaderStack.length) {
	            this._subStreamReaderStack.map(reader => reader.cancel(reason));
	        }
	        return this._reader.cancel && this._reader.cancel(reason);
	    }
	}

	/**
	 * Adapt a Reader to an UnderlyingSource, for wrapping into a ReadableStream.
	 *
	 * @param {Reader} reader
	 * @return {ReadableStream}
	 */
	function readerToStream(reader) {
	    return new ReadableStream({
	        pull(controller) {
	            return reader.read()
	                .then(res => {
	                    if (res.done) {
	                        controller.close();
	                    } else {
	                        controller.enqueue(res.value);
	                    }
	                });
	        },
	        cancel(reason) { return reader.cancel(reason); }
	    });
	}

	function toReader(s) {
	    if (s) {
	        if (typeof s.read === 'function') {
	            // Looks like a Reader.
	            return s;
	        }
	        if (typeof s.getReader === 'function') {
	            // ReadableStream
	            return s.getReader();
	        }
	        if (Array.isArray(s)) {
	            return new ArrayReader(s);
	        }
	    }
	    return new ArrayReader([s]);
	}

	function toStream(s) {
	    if (s) {
	        if (typeof s.getReader === 'function') {
	            // Already a ReadableStream
	            return s;
	        }
	        if (Array.isArray(s)) {
	            return arrayToStream(s);
	        }
	        if (typeof s.read === 'function') {
	            // Reader
	            return readerToStream(s);
	        }
	    }
	    return arrayToStream([s]);
	}

	function readToArray(s) {
	    const reader = toReader(s);
	    const accum = [];
	    function pump() {
	        return reader.read()
	        .then(res => {
	            if (res.done) {
	                return accum;
	            }
	            accum.push(res.value);
	            return pump();
	        });
	    }
	    return pump();
	}

	function readToString(s) {
	    const reader = toReader(s);
	    const decoder = new TextDecoder();
	    let accum = '';
	    function pump() {
	        return reader.read()
	        .then(res => {
	            if (res.done) {
	                // TODO: check decoder for completeness.
	                return accum;
	            }
	            accum += decoder.decode(res.value, { stream: true });
	            return pump();
	        });
	    }
	    return pump();
	}

	class TextDecodeReader {
	    constructor(reader) {
	        this._reader = toReader(reader);
	        this._decoder = new TextDecoder();
	    }

	    read() {
	        return this._reader.read()
	        .then(res => {
	            if (res.done) {
	                // TODO: Throw error if the decoder still holds onto some
	                // undecoded bytes!
	                return res;
	            }
	            res.value = this._decoder.decode(res.value, { stream: true });
	            return res;
	        });
	    }
	    cancel(reason) {
	        this._reader.cancel(reason);
	    }
	}

	class TextEncodeReader {
	    constructor(reader) {
	        this._reader = toReader(reader);
	        this._encoder = new TextEncoder();
	    }

	    read() {
	        return this._reader.read()
	        .then(res => {
	            if (res.done) {
	                // TODO: Throw error if the decoder still holds onto some
	                // undecoded bytes!
	                return res;
	            }
	            res.value = this._encoder.encode(res.value);
	            return res;
	        });
	    }
	    cancel(reason) {
	        this._reader.cancel(reason);
	    }
	}

	module.exports = {
	    // Utilities
	    toReader: toReader,
	    toStream: toStream,
	    readToArray: readToArray,
	    readToString: readToString,
	    // Text encode / decode (to/from byte) stream conversions
	    TextDecodeReader: TextDecodeReader,
	    TextEncodeReader: TextEncodeReader,
	    // Chunk evaluation
	    FlatStreamReader: FlatStreamReader,
	};


/***/ }
/******/ ]);