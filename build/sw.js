(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

const tplURL = '/wiki/Test';
const swt = require('sw-toolbox');

swt.precache([tplURL]);

function fetchBody(req, title) {
	const protoHost = req.url.match(/^(https?:\/\/[^\/]+)\//)[1];
    return swt.networkFirst(new Request(protoHost + '/api/rest_v1/page/html/'
                + encodeURIComponent(decodeURIComponent(title))), {
                    cache: {
                        name: 'api_html',
                        maxEntries: 100,
                        maxAgeSeconds: 186400
                    }
    })
    .then(res => {
        if (res.status === 200) {
            return res.text();
        } else {
            return "<body>Error fetching body for " + title + ': '
                + res.status + "</body>";
        }
    });
}

function getTemplate() {
    return swt.cacheFirst(tplURL);
}

function cheapBodyInnerHTML(html) {
    var match = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
    if (!match) {
        throw new Error('No HTML body found!');
    } else {
        return match[1];
    }
}

function replaceContent(tpl, content) {
    var bodyMatcher = /(<div id="mw-content-text"[^>]*>)[\s\S]*(<div class="printfooter")/im;
    return tpl.replace(bodyMatcher, (all, start, end) => start + content + end);
}

const escapes = {
    '<': '&lt;',
    '"': '&quot;',
    "'": '&#39;'
};

function injectBody(tpl, body, req, title) {
    // Hack hack hack..
    // In a real implementation, this will
    // - identify page components in a template,
    // - evaluate and each component, and
    // - stream expanded template parts / components as soon as they are
    //   available.
    tpl = tpl.replace(/Test/g, title.split('/').map(decodeURIComponent).join('/')
                                 .replace(/[<"']/g, s => escapes[s])
                                 .replace(/_/g, ' '));
    // Append parsoid and cite css modules
    tpl = tpl.replace(/modules=([^&]+)&/, 'modules=$1%7Cmediawiki.skinning.content.parsoid%7Cext.cite.style&');
    // tpl = tpl.replace(/\/wiki\//g, '/w/iki/');
    return replaceContent(tpl, cheapBodyInnerHTML(body));
}

function assemblePage(req) {
    var title = req.url.match(/\/w\/?iki\/([^?]+)$/)[1];
    return Promise.all([getTemplate(), fetchBody(req, title)])
        .then(results => injectBody(results[0], results[1], req, title));
}

swt.router.get(/https?:\/\/[^\/]+\/w\/?iki\/[^?]+$/, (request, options) => assemblePage(request)
        .then(body => new Response(body, {
            headers: {
                'content-type': 'text/html;charset=utf-8'
            }
        })));

},{"sw-toolbox":13}],2:[function(require,module,exports){
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

var globalOptions = require('./options');
var idbCacheExpiration = require('./idb-cache-expiration');

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

},{"./idb-cache-expiration":3,"./options":4}],3:[function(require,module,exports){
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

},{}],4:[function(require,module,exports){
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

},{}],5:[function(require,module,exports){
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
var pathRegexp = require('path-to-regexp');

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

},{"path-to-regexp":14}],6:[function(require,module,exports){
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

var Route = require('./route');

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

},{"./route":5}],7:[function(require,module,exports){
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
var helpers = require('../helpers');

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

},{"../helpers":2}],8:[function(require,module,exports){
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
var helpers = require('../helpers');

function cacheOnly(request, values, options) {
  helpers.debug('Strategy: cache only [' + request.url + ']', options);
  return helpers.openCache(options).then(function(cache) {
    return cache.match(request);
  });
}

module.exports = cacheOnly;

},{"../helpers":2}],9:[function(require,module,exports){
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
var helpers = require('../helpers');
var cacheOnly = require('./cacheOnly');

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

},{"../helpers":2,"./cacheOnly":8}],10:[function(require,module,exports){
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
  networkOnly: require('./networkOnly'),
  networkFirst: require('./networkFirst'),
  cacheOnly: require('./cacheOnly'),
  cacheFirst: require('./cacheFirst'),
  fastest: require('./fastest')
};

},{"./cacheFirst":7,"./cacheOnly":8,"./fastest":9,"./networkFirst":11,"./networkOnly":12}],11:[function(require,module,exports){
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
var globalOptions = require('../options');
var helpers = require('../helpers');

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

},{"../helpers":2,"../options":4}],12:[function(require,module,exports){
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
var helpers = require('../helpers');

function networkOnly(request, values, options) {
  helpers.debug('Strategy: network only [' + request.url + ']', options);
  return fetch(request);
}

module.exports = networkOnly;

},{"../helpers":2}],13:[function(require,module,exports){
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

require('serviceworker-cache-polyfill');
var options = require('./options');
var router = require('./router');
var helpers = require('./helpers');
var strategies = require('./strategies');

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

},{"./helpers":2,"./options":4,"./router":6,"./strategies":10,"serviceworker-cache-polyfill":16}],14:[function(require,module,exports){
var isarray = require('isarray')

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

},{"isarray":15}],15:[function(require,module,exports){
module.exports = Array.isArray || function (arr) {
  return Object.prototype.toString.call(arr) == '[object Array]';
};

},{}],16:[function(require,module,exports){
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
},{}]},{},[1])
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJsaWIvc3cuanMiLCJub2RlX21vZHVsZXMvc3ctdG9vbGJveC9saWIvaGVscGVycy5qcyIsIm5vZGVfbW9kdWxlcy9zdy10b29sYm94L2xpYi9pZGItY2FjaGUtZXhwaXJhdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9zdy10b29sYm94L2xpYi9vcHRpb25zLmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbGliL3JvdXRlLmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbGliL3JvdXRlci5qcyIsIm5vZGVfbW9kdWxlcy9zdy10b29sYm94L2xpYi9zdHJhdGVnaWVzL2NhY2hlRmlyc3QuanMiLCJub2RlX21vZHVsZXMvc3ctdG9vbGJveC9saWIvc3RyYXRlZ2llcy9jYWNoZU9ubHkuanMiLCJub2RlX21vZHVsZXMvc3ctdG9vbGJveC9saWIvc3RyYXRlZ2llcy9mYXN0ZXN0LmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbGliL3N0cmF0ZWdpZXMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvc3ctdG9vbGJveC9saWIvc3RyYXRlZ2llcy9uZXR3b3JrRmlyc3QuanMiLCJub2RlX21vZHVsZXMvc3ctdG9vbGJveC9saWIvc3RyYXRlZ2llcy9uZXR3b3JrT25seS5qcyIsIm5vZGVfbW9kdWxlcy9zdy10b29sYm94L2xpYi9zdy10b29sYm94LmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbm9kZV9tb2R1bGVzL3BhdGgtdG8tcmVnZXhwL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbm9kZV9tb2R1bGVzL3BhdGgtdG8tcmVnZXhwL25vZGVfbW9kdWxlcy9pc2FycmF5L2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbm9kZV9tb2R1bGVzL3NlcnZpY2V3b3JrZXItY2FjaGUtcG9seWZpbGwvaW5kZXguanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQy9FQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUlBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5SkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN4Q0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNURBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDL0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxYUE7QUFDQTtBQUNBO0FBQ0E7O0FDSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiJ3VzZSBzdHJpY3QnO1xuXG5jb25zdCB0cGxVUkwgPSAnL3dpa2kvVGVzdCc7XG5jb25zdCBzd3QgPSByZXF1aXJlKCdzdy10b29sYm94Jyk7XG5cbnN3dC5wcmVjYWNoZShbdHBsVVJMXSk7XG5cbmZ1bmN0aW9uIGZldGNoQm9keShyZXEsIHRpdGxlKSB7XG5cdGNvbnN0IHByb3RvSG9zdCA9IHJlcS51cmwubWF0Y2goL14oaHR0cHM/OlxcL1xcL1teXFwvXSspXFwvLylbMV07XG4gICAgcmV0dXJuIHN3dC5uZXR3b3JrRmlyc3QobmV3IFJlcXVlc3QocHJvdG9Ib3N0ICsgJy9hcGkvcmVzdF92MS9wYWdlL2h0bWwvJ1xuICAgICAgICAgICAgICAgICsgZW5jb2RlVVJJQ29tcG9uZW50KGRlY29kZVVSSUNvbXBvbmVudCh0aXRsZSkpKSwge1xuICAgICAgICAgICAgICAgICAgICBjYWNoZToge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmFtZTogJ2FwaV9odG1sJyxcbiAgICAgICAgICAgICAgICAgICAgICAgIG1heEVudHJpZXM6IDEwMCxcbiAgICAgICAgICAgICAgICAgICAgICAgIG1heEFnZVNlY29uZHM6IDE4NjQwMFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgfSlcbiAgICAudGhlbihyZXMgPT4ge1xuICAgICAgICBpZiAocmVzLnN0YXR1cyA9PT0gMjAwKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzLnRleHQoKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBcIjxib2R5PkVycm9yIGZldGNoaW5nIGJvZHkgZm9yIFwiICsgdGl0bGUgKyAnOiAnXG4gICAgICAgICAgICAgICAgKyByZXMuc3RhdHVzICsgXCI8L2JvZHk+XCI7XG4gICAgICAgIH1cbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gZ2V0VGVtcGxhdGUoKSB7XG4gICAgcmV0dXJuIHN3dC5jYWNoZUZpcnN0KHRwbFVSTCk7XG59XG5cbmZ1bmN0aW9uIGNoZWFwQm9keUlubmVySFRNTChodG1sKSB7XG4gICAgdmFyIG1hdGNoID0gLzxib2R5W14+XSo+KFtcXHNcXFNdKik8XFwvYm9keT4vLmV4ZWMoaHRtbCk7XG4gICAgaWYgKCFtYXRjaCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vIEhUTUwgYm9keSBmb3VuZCEnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gbWF0Y2hbMV07XG4gICAgfVxufVxuXG5mdW5jdGlvbiByZXBsYWNlQ29udGVudCh0cGwsIGNvbnRlbnQpIHtcbiAgICB2YXIgYm9keU1hdGNoZXIgPSAvKDxkaXYgaWQ9XCJtdy1jb250ZW50LXRleHRcIltePl0qPilbXFxzXFxTXSooPGRpdiBjbGFzcz1cInByaW50Zm9vdGVyXCIpL2ltO1xuICAgIHJldHVybiB0cGwucmVwbGFjZShib2R5TWF0Y2hlciwgKGFsbCwgc3RhcnQsIGVuZCkgPT4gc3RhcnQgKyBjb250ZW50ICsgZW5kKTtcbn1cblxuY29uc3QgZXNjYXBlcyA9IHtcbiAgICAnPCc6ICcmbHQ7JyxcbiAgICAnXCInOiAnJnF1b3Q7JyxcbiAgICBcIidcIjogJyYjMzk7J1xufTtcblxuZnVuY3Rpb24gaW5qZWN0Qm9keSh0cGwsIGJvZHksIHJlcSwgdGl0bGUpIHtcbiAgICAvLyBIYWNrIGhhY2sgaGFjay4uXG4gICAgLy8gSW4gYSByZWFsIGltcGxlbWVudGF0aW9uLCB0aGlzIHdpbGxcbiAgICAvLyAtIGlkZW50aWZ5IHBhZ2UgY29tcG9uZW50cyBpbiBhIHRlbXBsYXRlLFxuICAgIC8vIC0gZXZhbHVhdGUgYW5kIGVhY2ggY29tcG9uZW50LCBhbmRcbiAgICAvLyAtIHN0cmVhbSBleHBhbmRlZCB0ZW1wbGF0ZSBwYXJ0cyAvIGNvbXBvbmVudHMgYXMgc29vbiBhcyB0aGV5IGFyZVxuICAgIC8vICAgYXZhaWxhYmxlLlxuICAgIHRwbCA9IHRwbC5yZXBsYWNlKC9UZXN0L2csIHRpdGxlLnNwbGl0KCcvJykubWFwKGRlY29kZVVSSUNvbXBvbmVudCkuam9pbignLycpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAucmVwbGFjZSgvWzxcIiddL2csIHMgPT4gZXNjYXBlc1tzXSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9fL2csICcgJykpO1xuICAgIC8vIEFwcGVuZCBwYXJzb2lkIGFuZCBjaXRlIGNzcyBtb2R1bGVzXG4gICAgdHBsID0gdHBsLnJlcGxhY2UoL21vZHVsZXM9KFteJl0rKSYvLCAnbW9kdWxlcz0kMSU3Q21lZGlhd2lraS5za2lubmluZy5jb250ZW50LnBhcnNvaWQlN0NleHQuY2l0ZS5zdHlsZSYnKTtcbiAgICAvLyB0cGwgPSB0cGwucmVwbGFjZSgvXFwvd2lraVxcLy9nLCAnL3cvaWtpLycpO1xuICAgIHJldHVybiByZXBsYWNlQ29udGVudCh0cGwsIGNoZWFwQm9keUlubmVySFRNTChib2R5KSk7XG59XG5cbmZ1bmN0aW9uIGFzc2VtYmxlUGFnZShyZXEpIHtcbiAgICB2YXIgdGl0bGUgPSByZXEudXJsLm1hdGNoKC9cXC93XFwvP2lraVxcLyhbXj9dKykkLylbMV07XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKFtnZXRUZW1wbGF0ZSgpLCBmZXRjaEJvZHkocmVxLCB0aXRsZSldKVxuICAgICAgICAudGhlbihyZXN1bHRzID0+IGluamVjdEJvZHkocmVzdWx0c1swXSwgcmVzdWx0c1sxXSwgcmVxLCB0aXRsZSkpO1xufVxuXG5zd3Qucm91dGVyLmdldCgvaHR0cHM/OlxcL1xcL1teXFwvXStcXC93XFwvP2lraVxcL1teP10rJC8sIChyZXF1ZXN0LCBvcHRpb25zKSA9PiBhc3NlbWJsZVBhZ2UocmVxdWVzdClcbiAgICAgICAgLnRoZW4oYm9keSA9PiBuZXcgUmVzcG9uc2UoYm9keSwge1xuICAgICAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICAgICAgICdjb250ZW50LXR5cGUnOiAndGV4dC9odG1sO2NoYXJzZXQ9dXRmLTgnXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pKSk7XG4iLCIvKlxuICBDb3B5cmlnaHQgMjAxNCBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG4gIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG4gIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cbiAgWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG4gIFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcbiAgZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICBXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cbiAgU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuICBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBnbG9iYWxPcHRpb25zID0gcmVxdWlyZSgnLi9vcHRpb25zJyk7XG52YXIgaWRiQ2FjaGVFeHBpcmF0aW9uID0gcmVxdWlyZSgnLi9pZGItY2FjaGUtZXhwaXJhdGlvbicpO1xuXG5mdW5jdGlvbiBkZWJ1ZyhtZXNzYWdlLCBvcHRpb25zKSB7XG4gIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICB2YXIgZmxhZyA9IG9wdGlvbnMuZGVidWcgfHwgZ2xvYmFsT3B0aW9ucy5kZWJ1ZztcbiAgaWYgKGZsYWcpIHtcbiAgICBjb25zb2xlLmxvZygnW3N3LXRvb2xib3hdICcgKyBtZXNzYWdlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBvcGVuQ2FjaGUob3B0aW9ucykge1xuICB2YXIgY2FjaGVOYW1lO1xuICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmNhY2hlKSB7XG4gICAgY2FjaGVOYW1lID0gb3B0aW9ucy5jYWNoZS5uYW1lO1xuICB9XG4gIGNhY2hlTmFtZSA9IGNhY2hlTmFtZSB8fCBnbG9iYWxPcHRpb25zLmNhY2hlLm5hbWU7XG5cbiAgcmV0dXJuIGNhY2hlcy5vcGVuKGNhY2hlTmFtZSk7XG59XG5cbmZ1bmN0aW9uIGZldGNoQW5kQ2FjaGUocmVxdWVzdCwgb3B0aW9ucykge1xuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgdmFyIHN1Y2Nlc3NSZXNwb25zZXMgPSBvcHRpb25zLnN1Y2Nlc3NSZXNwb25zZXMgfHxcbiAgICAgIGdsb2JhbE9wdGlvbnMuc3VjY2Vzc1Jlc3BvbnNlcztcblxuICByZXR1cm4gZmV0Y2gocmVxdWVzdC5jbG9uZSgpKS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgLy8gT25seSBjYWNoZSBHRVQgcmVxdWVzdHMgd2l0aCBzdWNjZXNzZnVsIHJlc3BvbnNlcy5cbiAgICAvLyBTaW5jZSB0aGlzIGlzIG5vdCBwYXJ0IG9mIHRoZSBwcm9taXNlIGNoYWluLCBpdCB3aWxsIGJlIGRvbmVcbiAgICAvLyBhc3luY2hyb25vdXNseSBhbmQgd2lsbCBub3QgYmxvY2sgdGhlIHJlc3BvbnNlIGZyb20gYmVpbmcgcmV0dXJuZWQgdG8gdGhlXG4gICAgLy8gcGFnZS5cbiAgICBpZiAocmVxdWVzdC5tZXRob2QgPT09ICdHRVQnICYmIHN1Y2Nlc3NSZXNwb25zZXMudGVzdChyZXNwb25zZS5zdGF0dXMpKSB7XG4gICAgICBvcGVuQ2FjaGUob3B0aW9ucykudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgICAgICBjYWNoZS5wdXQocmVxdWVzdCwgcmVzcG9uc2UpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICAgICAgLy8gSWYgYW55IG9mIHRoZSBvcHRpb25zIGFyZSBwcm92aWRlZCBpbiBvcHRpb25zLmNhY2hlIHRoZW4gdXNlIHRoZW0uXG4gICAgICAgICAgLy8gRG8gbm90IGZhbGxiYWNrIHRvIHRoZSBnbG9iYWwgb3B0aW9ucyBmb3IgYW55IHRoYXQgYXJlIG1pc3NpbmdcbiAgICAgICAgICAvLyB1bmxlc3MgdGhleSBhcmUgYWxsIG1pc3NpbmcuXG4gICAgICAgICAgdmFyIGNhY2hlT3B0aW9ucyA9IG9wdGlvbnMuY2FjaGUgfHwgZ2xvYmFsT3B0aW9ucy5jYWNoZTtcblxuICAgICAgICAgIC8vIE9ubHkgcnVuIHRoZSBjYWNoZSBleHBpcmF0aW9uIGxvZ2ljIGlmIGF0IGxlYXN0IG9uZSBvZiB0aGUgbWF4aW11bXNcbiAgICAgICAgICAvLyBpcyBzZXQsIGFuZCBpZiB3ZSBoYXZlIGEgbmFtZSBmb3IgdGhlIGNhY2hlIHRoYXQgdGhlIG9wdGlvbnMgYXJlXG4gICAgICAgICAgLy8gYmVpbmcgYXBwbGllZCB0by5cbiAgICAgICAgICBpZiAoKGNhY2hlT3B0aW9ucy5tYXhFbnRyaWVzIHx8IGNhY2hlT3B0aW9ucy5tYXhBZ2VTZWNvbmRzKSAmJlxuICAgICAgICAgICAgICBjYWNoZU9wdGlvbnMubmFtZSkge1xuICAgICAgICAgICAgcXVldWVDYWNoZUV4cGlyYXRpb24ocmVxdWVzdCwgY2FjaGUsIGNhY2hlT3B0aW9ucyk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiByZXNwb25zZS5jbG9uZSgpO1xuICB9KTtcbn1cblxudmFyIGNsZWFudXBRdWV1ZTtcbmZ1bmN0aW9uIHF1ZXVlQ2FjaGVFeHBpcmF0aW9uKHJlcXVlc3QsIGNhY2hlLCBjYWNoZU9wdGlvbnMpIHtcbiAgdmFyIGNsZWFudXAgPSBjbGVhbnVwQ2FjaGUuYmluZChudWxsLCByZXF1ZXN0LCBjYWNoZSwgY2FjaGVPcHRpb25zKTtcblxuICBpZiAoY2xlYW51cFF1ZXVlKSB7XG4gICAgY2xlYW51cFF1ZXVlID0gY2xlYW51cFF1ZXVlLnRoZW4oY2xlYW51cCk7XG4gIH0gZWxzZSB7XG4gICAgY2xlYW51cFF1ZXVlID0gY2xlYW51cCgpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNsZWFudXBDYWNoZShyZXF1ZXN0LCBjYWNoZSwgY2FjaGVPcHRpb25zKSB7XG4gIHZhciByZXF1ZXN0VXJsID0gcmVxdWVzdC51cmw7XG4gIHZhciBtYXhBZ2VTZWNvbmRzID0gY2FjaGVPcHRpb25zLm1heEFnZVNlY29uZHM7XG4gIHZhciBtYXhFbnRyaWVzID0gY2FjaGVPcHRpb25zLm1heEVudHJpZXM7XG4gIHZhciBjYWNoZU5hbWUgPSBjYWNoZU9wdGlvbnMubmFtZTtcblxuICB2YXIgbm93ID0gRGF0ZS5ub3coKTtcbiAgZGVidWcoJ1VwZGF0aW5nIExSVSBvcmRlciBmb3IgJyArIHJlcXVlc3RVcmwgKyAnLiBNYXggZW50cmllcyBpcyAnICtcbiAgICBtYXhFbnRyaWVzICsgJywgbWF4IGFnZSBpcyAnICsgbWF4QWdlU2Vjb25kcyk7XG5cbiAgcmV0dXJuIGlkYkNhY2hlRXhwaXJhdGlvbi5nZXREYihjYWNoZU5hbWUpLnRoZW4oZnVuY3Rpb24oZGIpIHtcbiAgICByZXR1cm4gaWRiQ2FjaGVFeHBpcmF0aW9uLnNldFRpbWVzdGFtcEZvclVybChkYiwgcmVxdWVzdFVybCwgbm93KTtcbiAgfSkudGhlbihmdW5jdGlvbihkYikge1xuICAgIHJldHVybiBpZGJDYWNoZUV4cGlyYXRpb24uZXhwaXJlRW50cmllcyhkYiwgbWF4RW50cmllcywgbWF4QWdlU2Vjb25kcywgbm93KTtcbiAgfSkudGhlbihmdW5jdGlvbih1cmxzVG9EZWxldGUpIHtcbiAgICBkZWJ1ZygnU3VjY2Vzc2Z1bGx5IHVwZGF0ZWQgSURCLicpO1xuXG4gICAgdmFyIGRlbGV0aW9uUHJvbWlzZXMgPSB1cmxzVG9EZWxldGUubWFwKGZ1bmN0aW9uKHVybFRvRGVsZXRlKSB7XG4gICAgICByZXR1cm4gY2FjaGUuZGVsZXRlKHVybFRvRGVsZXRlKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBQcm9taXNlLmFsbChkZWxldGlvblByb21pc2VzKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgZGVidWcoJ0RvbmUgd2l0aCBjYWNoZSBjbGVhbnVwLicpO1xuICAgIH0pO1xuICB9KS5jYXRjaChmdW5jdGlvbihlcnJvcikge1xuICAgIGRlYnVnKGVycm9yKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmFtZUNhY2hlKHNvdXJjZSwgZGVzdGluYXRpb24sIG9wdGlvbnMpIHtcbiAgZGVidWcoJ1JlbmFtaW5nIGNhY2hlOiBbJyArIHNvdXJjZSArICddIHRvIFsnICsgZGVzdGluYXRpb24gKyAnXScsIG9wdGlvbnMpO1xuICByZXR1cm4gY2FjaGVzLmRlbGV0ZShkZXN0aW5hdGlvbikudGhlbihmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoW1xuICAgICAgY2FjaGVzLm9wZW4oc291cmNlKSxcbiAgICAgIGNhY2hlcy5vcGVuKGRlc3RpbmF0aW9uKVxuICAgIF0pLnRoZW4oZnVuY3Rpb24ocmVzdWx0cykge1xuICAgICAgdmFyIHNvdXJjZUNhY2hlID0gcmVzdWx0c1swXTtcbiAgICAgIHZhciBkZXN0Q2FjaGUgPSByZXN1bHRzWzFdO1xuXG4gICAgICByZXR1cm4gc291cmNlQ2FjaGUua2V5cygpLnRoZW4oZnVuY3Rpb24ocmVxdWVzdHMpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKHJlcXVlc3RzLm1hcChmdW5jdGlvbihyZXF1ZXN0KSB7XG4gICAgICAgICAgcmV0dXJuIHNvdXJjZUNhY2hlLm1hdGNoKHJlcXVlc3QpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgICAgICAgIHJldHVybiBkZXN0Q2FjaGUucHV0KHJlcXVlc3QsIHJlc3BvbnNlKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSkpO1xuICAgICAgfSkudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIGNhY2hlcy5kZWxldGUoc291cmNlKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIGRlYnVnOiBkZWJ1ZyxcbiAgZmV0Y2hBbmRDYWNoZTogZmV0Y2hBbmRDYWNoZSxcbiAgb3BlbkNhY2hlOiBvcGVuQ2FjaGUsXG4gIHJlbmFtZUNhY2hlOiByZW5hbWVDYWNoZVxufTtcbiIsIi8qXG4gQ29weXJpZ2h0IDIwMTUgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cblxuIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG4geW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuIFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuXG4gICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG4gVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuIGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcbiBXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cbiBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gbGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4qL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgREJfUFJFRklYID0gJ3N3LXRvb2xib3gtJztcbnZhciBEQl9WRVJTSU9OID0gMTtcbnZhciBTVE9SRV9OQU1FID0gJ3N0b3JlJztcbnZhciBVUkxfUFJPUEVSVFkgPSAndXJsJztcbnZhciBUSU1FU1RBTVBfUFJPUEVSVFkgPSAndGltZXN0YW1wJztcbnZhciBjYWNoZU5hbWVUb0RiUHJvbWlzZSA9IHt9O1xuXG5mdW5jdGlvbiBvcGVuRGIoY2FjaGVOYW1lKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgcmVxdWVzdCA9IGluZGV4ZWREQi5vcGVuKERCX1BSRUZJWCArIGNhY2hlTmFtZSwgREJfVkVSU0lPTik7XG5cbiAgICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIG9iamVjdFN0b3JlID0gcmVxdWVzdC5yZXN1bHQuY3JlYXRlT2JqZWN0U3RvcmUoU1RPUkVfTkFNRSxcbiAgICAgICAgICB7a2V5UGF0aDogVVJMX1BST1BFUlRZfSk7XG4gICAgICBvYmplY3RTdG9yZS5jcmVhdGVJbmRleChUSU1FU1RBTVBfUFJPUEVSVFksIFRJTUVTVEFNUF9QUk9QRVJUWSxcbiAgICAgICAgICB7dW5pcXVlOiBmYWxzZX0pO1xuICAgIH07XG5cbiAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9IGZ1bmN0aW9uKCkge1xuICAgICAgcmVzb2x2ZShyZXF1ZXN0LnJlc3VsdCk7XG4gICAgfTtcblxuICAgIHJlcXVlc3Qub25lcnJvciA9IGZ1bmN0aW9uKCkge1xuICAgICAgcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgIH07XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBnZXREYihjYWNoZU5hbWUpIHtcbiAgaWYgKCEoY2FjaGVOYW1lIGluIGNhY2hlTmFtZVRvRGJQcm9taXNlKSkge1xuICAgIGNhY2hlTmFtZVRvRGJQcm9taXNlW2NhY2hlTmFtZV0gPSBvcGVuRGIoY2FjaGVOYW1lKTtcbiAgfVxuXG4gIHJldHVybiBjYWNoZU5hbWVUb0RiUHJvbWlzZVtjYWNoZU5hbWVdO1xufVxuXG5mdW5jdGlvbiBzZXRUaW1lc3RhbXBGb3JVcmwoZGIsIHVybCwgbm93KSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihTVE9SRV9OQU1FLCAncmVhZHdyaXRlJyk7XG4gICAgdmFyIG9iamVjdFN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoU1RPUkVfTkFNRSk7XG4gICAgb2JqZWN0U3RvcmUucHV0KHt1cmw6IHVybCwgdGltZXN0YW1wOiBub3d9KTtcblxuICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSBmdW5jdGlvbigpIHtcbiAgICAgIHJlc29sdmUoZGIpO1xuICAgIH07XG5cbiAgICB0cmFuc2FjdGlvbi5vbmFib3J0ID0gZnVuY3Rpb24oKSB7XG4gICAgICByZWplY3QodHJhbnNhY3Rpb24uZXJyb3IpO1xuICAgIH07XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBleHBpcmVPbGRFbnRyaWVzKGRiLCBtYXhBZ2VTZWNvbmRzLCBub3cpIHtcbiAgLy8gQmFpbCBvdXQgZWFybHkgYnkgcmVzb2x2aW5nIHdpdGggYW4gZW1wdHkgYXJyYXkgaWYgd2UncmUgbm90IHVzaW5nXG4gIC8vIG1heEFnZVNlY29uZHMuXG4gIGlmICghbWF4QWdlU2Vjb25kcykge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoW10pO1xuICB9XG5cbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHZhciBtYXhBZ2VNaWxsaXMgPSBtYXhBZ2VTZWNvbmRzICogMTAwMDtcbiAgICB2YXIgdXJscyA9IFtdO1xuXG4gICAgdmFyIHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oU1RPUkVfTkFNRSwgJ3JlYWR3cml0ZScpO1xuICAgIHZhciBvYmplY3RTdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xuICAgIHZhciBpbmRleCA9IG9iamVjdFN0b3JlLmluZGV4KFRJTUVTVEFNUF9QUk9QRVJUWSk7XG5cbiAgICBpbmRleC5vcGVuQ3Vyc29yKCkub25zdWNjZXNzID0gZnVuY3Rpb24oY3Vyc29yRXZlbnQpIHtcbiAgICAgIHZhciBjdXJzb3IgPSBjdXJzb3JFdmVudC50YXJnZXQucmVzdWx0O1xuICAgICAgaWYgKGN1cnNvcikge1xuICAgICAgICBpZiAobm93IC0gbWF4QWdlTWlsbGlzID4gY3Vyc29yLnZhbHVlW1RJTUVTVEFNUF9QUk9QRVJUWV0pIHtcbiAgICAgICAgICB2YXIgdXJsID0gY3Vyc29yLnZhbHVlW1VSTF9QUk9QRVJUWV07XG4gICAgICAgICAgdXJscy5wdXNoKHVybCk7XG4gICAgICAgICAgb2JqZWN0U3RvcmUuZGVsZXRlKHVybCk7XG4gICAgICAgICAgY3Vyc29yLmNvbnRpbnVlKCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9O1xuXG4gICAgdHJhbnNhY3Rpb24ub25jb21wbGV0ZSA9IGZ1bmN0aW9uKCkge1xuICAgICAgcmVzb2x2ZSh1cmxzKTtcbiAgICB9O1xuXG4gICAgdHJhbnNhY3Rpb24ub25hYm9ydCA9IHJlamVjdDtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGV4cGlyZUV4dHJhRW50cmllcyhkYiwgbWF4RW50cmllcykge1xuICAvLyBCYWlsIG91dCBlYXJseSBieSByZXNvbHZpbmcgd2l0aCBhbiBlbXB0eSBhcnJheSBpZiB3ZSdyZSBub3QgdXNpbmdcbiAgLy8gbWF4RW50cmllcy5cbiAgaWYgKCFtYXhFbnRyaWVzKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShbXSk7XG4gIH1cblxuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgdmFyIHVybHMgPSBbXTtcblxuICAgIHZhciB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKFNUT1JFX05BTUUsICdyZWFkd3JpdGUnKTtcbiAgICB2YXIgb2JqZWN0U3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcbiAgICB2YXIgaW5kZXggPSBvYmplY3RTdG9yZS5pbmRleChUSU1FU1RBTVBfUFJPUEVSVFkpO1xuXG4gICAgdmFyIGNvdW50UmVxdWVzdCA9IGluZGV4LmNvdW50KCk7XG4gICAgaW5kZXguY291bnQoKS5vbnN1Y2Nlc3MgPSBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBpbml0aWFsQ291bnQgPSBjb3VudFJlcXVlc3QucmVzdWx0O1xuXG4gICAgICBpZiAoaW5pdGlhbENvdW50ID4gbWF4RW50cmllcykge1xuICAgICAgICBpbmRleC5vcGVuQ3Vyc29yKCkub25zdWNjZXNzID0gZnVuY3Rpb24oY3Vyc29yRXZlbnQpIHtcbiAgICAgICAgICB2YXIgY3Vyc29yID0gY3Vyc29yRXZlbnQudGFyZ2V0LnJlc3VsdDtcbiAgICAgICAgICBpZiAoY3Vyc29yKSB7XG4gICAgICAgICAgICB2YXIgdXJsID0gY3Vyc29yLnZhbHVlW1VSTF9QUk9QRVJUWV07XG4gICAgICAgICAgICB1cmxzLnB1c2godXJsKTtcbiAgICAgICAgICAgIG9iamVjdFN0b3JlLmRlbGV0ZSh1cmwpO1xuICAgICAgICAgICAgaWYgKGluaXRpYWxDb3VudCAtIHVybHMubGVuZ3RoID4gbWF4RW50cmllcykge1xuICAgICAgICAgICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfTtcblxuICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSBmdW5jdGlvbigpIHtcbiAgICAgIHJlc29sdmUodXJscyk7XG4gICAgfTtcblxuICAgIHRyYW5zYWN0aW9uLm9uYWJvcnQgPSByZWplY3Q7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBleHBpcmVFbnRyaWVzKGRiLCBtYXhFbnRyaWVzLCBtYXhBZ2VTZWNvbmRzLCBub3cpIHtcbiAgcmV0dXJuIGV4cGlyZU9sZEVudHJpZXMoZGIsIG1heEFnZVNlY29uZHMsIG5vdykudGhlbihmdW5jdGlvbihvbGRVcmxzKSB7XG4gICAgcmV0dXJuIGV4cGlyZUV4dHJhRW50cmllcyhkYiwgbWF4RW50cmllcykudGhlbihmdW5jdGlvbihleHRyYVVybHMpIHtcbiAgICAgIHJldHVybiBvbGRVcmxzLmNvbmNhdChleHRyYVVybHMpO1xuICAgIH0pO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIGdldERiOiBnZXREYixcbiAgc2V0VGltZXN0YW1wRm9yVXJsOiBzZXRUaW1lc3RhbXBGb3JVcmwsXG4gIGV4cGlyZUVudHJpZXM6IGV4cGlyZUVudHJpZXNcbn07XG4iLCIvKlxuXHRDb3B5cmlnaHQgMjAxNSBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG5cdExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG5cdHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cblx0WW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG5cdFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcblx0ZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuXHRXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cblx0U2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuXHRsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG4ndXNlIHN0cmljdCc7XG5cbi8vIFRPRE86IFRoaXMgaXMgbmVjZXNzYXJ5IHRvIGhhbmRsZSBkaWZmZXJlbnQgaW1wbGVtZW50YXRpb25zIGluIHRoZSB3aWxkXG4vLyBUaGUgc3BlYyBkZWZpbmVzIHNlbGYucmVnaXN0cmF0aW9uLCBidXQgaXQgd2FzIG5vdCBpbXBsZW1lbnRlZCBpbiBDaHJvbWUgNDAuXG52YXIgc2NvcGU7XG5pZiAoc2VsZi5yZWdpc3RyYXRpb24pIHtcbiAgc2NvcGUgPSBzZWxmLnJlZ2lzdHJhdGlvbi5zY29wZTtcbn0gZWxzZSB7XG4gIHNjb3BlID0gc2VsZi5zY29wZSB8fCBuZXcgVVJMKCcuLycsIHNlbGYubG9jYXRpb24pLmhyZWY7XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBjYWNoZToge1xuICAgIG5hbWU6ICckJCR0b29sYm94LWNhY2hlJCQkJyArIHNjb3BlICsgJyQkJCcsXG4gICAgbWF4QWdlU2Vjb25kczogbnVsbCxcbiAgICBtYXhFbnRyaWVzOiBudWxsXG4gIH0sXG4gIGRlYnVnOiBmYWxzZSxcbiAgbmV0d29ya1RpbWVvdXRTZWNvbmRzOiBudWxsLFxuICBwcmVDYWNoZUl0ZW1zOiBbXSxcbiAgLy8gQSByZWd1bGFyIGV4cHJlc3Npb24gdG8gYXBwbHkgdG8gSFRUUCByZXNwb25zZSBjb2Rlcy4gQ29kZXMgdGhhdCBtYXRjaFxuICAvLyB3aWxsIGJlIGNvbnNpZGVyZWQgc3VjY2Vzc2VzLCB3aGlsZSBvdGhlcnMgd2lsbCBub3QsIGFuZCB3aWxsIG5vdCBiZVxuICAvLyBjYWNoZWQuXG4gIHN1Y2Nlc3NSZXNwb25zZXM6IC9eMHwoWzEyM11cXGRcXGQpfCg0MFsxNDU2N10pfDQxMCQvXG59O1xuIiwiLypcbiAgQ29weXJpZ2h0IDIwMTQgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cblxuICBMaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xuICB5b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG4gIFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuXG4gICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcblxuICBVbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG4gIGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcbiAgV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG4gIFNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcbiAgbGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4qL1xuJ3VzZSBzdHJpY3QnO1xuXG4vLyBUT0RPOiBVc2Ugc2VsZi5yZWdpc3RyYXRpb24uc2NvcGUgaW5zdGVhZCBvZiBzZWxmLmxvY2F0aW9uXG52YXIgdXJsID0gbmV3IFVSTCgnLi8nLCBzZWxmLmxvY2F0aW9uKTtcbnZhciBiYXNlUGF0aCA9IHVybC5wYXRobmFtZTtcbnZhciBwYXRoUmVnZXhwID0gcmVxdWlyZSgncGF0aC10by1yZWdleHAnKTtcblxudmFyIFJvdXRlID0gZnVuY3Rpb24obWV0aG9kLCBwYXRoLCBoYW5kbGVyLCBvcHRpb25zKSB7XG4gIGlmIChwYXRoIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgdGhpcy5mdWxsVXJsUmVnRXhwID0gcGF0aDtcbiAgfSBlbHNlIHtcbiAgICAvLyBUaGUgVVJMKCkgY29uc3RydWN0b3IgY2FuJ3QgcGFyc2UgZXhwcmVzcy1zdHlsZSByb3V0ZXMgYXMgdGhleSBhcmUgbm90XG4gICAgLy8gdmFsaWQgdXJscy4gVGhpcyBtZWFucyB3ZSBoYXZlIHRvIG1hbnVhbGx5IG1hbmlwdWxhdGUgcmVsYXRpdmUgdXJscyBpbnRvXG4gICAgLy8gYWJzb2x1dGUgb25lcy4gVGhpcyBjaGVjayBpcyBleHRyZW1lbHkgbmFpdmUgYnV0IGltcGxlbWVudGluZyBhIHR3ZWFrZWRcbiAgICAvLyB2ZXJzaW9uIG9mIHRoZSBmdWxsIGFsZ29yaXRobSBzZWVtcyBsaWtlIG92ZXJraWxsXG4gICAgLy8gKGh0dHBzOi8vdXJsLnNwZWMud2hhdHdnLm9yZy8jY29uY2VwdC1iYXNpYy11cmwtcGFyc2VyKVxuICAgIGlmIChwYXRoLmluZGV4T2YoJy8nKSAhPT0gMCkge1xuICAgICAgcGF0aCA9IGJhc2VQYXRoICsgcGF0aDtcbiAgICB9XG5cbiAgICB0aGlzLmtleXMgPSBbXTtcbiAgICB0aGlzLnJlZ2V4cCA9IHBhdGhSZWdleHAocGF0aCwgdGhpcy5rZXlzKTtcbiAgfVxuXG4gIHRoaXMubWV0aG9kID0gbWV0aG9kO1xuICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zO1xuICB0aGlzLmhhbmRsZXIgPSBoYW5kbGVyO1xufTtcblxuUm91dGUucHJvdG90eXBlLm1ha2VIYW5kbGVyID0gZnVuY3Rpb24odXJsKSB7XG4gIHZhciB2YWx1ZXM7XG4gIGlmICh0aGlzLnJlZ2V4cCkge1xuICAgIHZhciBtYXRjaCA9IHRoaXMucmVnZXhwLmV4ZWModXJsKTtcbiAgICB2YWx1ZXMgPSB7fTtcbiAgICB0aGlzLmtleXMuZm9yRWFjaChmdW5jdGlvbihrZXksIGluZGV4KSB7XG4gICAgICB2YWx1ZXNba2V5Lm5hbWVdID0gbWF0Y2hbaW5kZXggKyAxXTtcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbihyZXF1ZXN0KSB7XG4gICAgcmV0dXJuIHRoaXMuaGFuZGxlcihyZXF1ZXN0LCB2YWx1ZXMsIHRoaXMub3B0aW9ucyk7XG4gIH0uYmluZCh0aGlzKTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gUm91dGU7XG4iLCIvKlxuICBDb3B5cmlnaHQgMjAxNCBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG4gIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG4gIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cbiAgWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG4gIFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcbiAgZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICBXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cbiAgU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuICBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBSb3V0ZSA9IHJlcXVpcmUoJy4vcm91dGUnKTtcblxuZnVuY3Rpb24gcmVnZXhFc2NhcGUocykge1xuICByZXR1cm4gcy5yZXBsYWNlKC9bLVxcL1xcXFxeJCorPy4oKXxbXFxde31dL2csICdcXFxcJCYnKTtcbn1cblxudmFyIGtleU1hdGNoID0gZnVuY3Rpb24obWFwLCBzdHJpbmcpIHtcbiAgLy8gVGhpcyB3b3VsZCBiZSBiZXR0ZXIgd3JpdHRlbiBhcyBhIGZvci4ub2YgbG9vcCwgYnV0IHRoYXQgd291bGQgYnJlYWsgdGhlXG4gIC8vIG1pbmlmeWlmeSBwcm9jZXNzIGluIHRoZSBidWlsZC5cbiAgdmFyIGVudHJpZXNJdGVyYXRvciA9IG1hcC5lbnRyaWVzKCk7XG4gIHZhciBpdGVtID0gZW50cmllc0l0ZXJhdG9yLm5leHQoKTtcbiAgdmFyIG1hdGNoZXMgPSBbXTtcbiAgd2hpbGUgKCFpdGVtLmRvbmUpIHtcbiAgICB2YXIgcGF0dGVybiA9IG5ldyBSZWdFeHAoaXRlbS52YWx1ZVswXSk7XG4gICAgaWYgKHBhdHRlcm4udGVzdChzdHJpbmcpKSB7XG4gICAgICBtYXRjaGVzLnB1c2goaXRlbS52YWx1ZVsxXSk7XG4gICAgfVxuICAgIGl0ZW0gPSBlbnRyaWVzSXRlcmF0b3IubmV4dCgpO1xuICB9XG4gIHJldHVybiBtYXRjaGVzO1xufTtcblxudmFyIFJvdXRlciA9IGZ1bmN0aW9uKCkge1xuICB0aGlzLnJvdXRlcyA9IG5ldyBNYXAoKTtcbiAgLy8gQ3JlYXRlIHRoZSBkdW1teSBvcmlnaW4gZm9yIFJlZ0V4cC1iYXNlZCByb3V0ZXNcbiAgdGhpcy5yb3V0ZXMuc2V0KFJlZ0V4cCwgbmV3IE1hcCgpKTtcbiAgdGhpcy5kZWZhdWx0ID0gbnVsbDtcbn07XG5cblsnZ2V0JywgJ3Bvc3QnLCAncHV0JywgJ2RlbGV0ZScsICdoZWFkJywgJ2FueSddLmZvckVhY2goZnVuY3Rpb24obWV0aG9kKSB7XG4gIFJvdXRlci5wcm90b3R5cGVbbWV0aG9kXSA9IGZ1bmN0aW9uKHBhdGgsIGhhbmRsZXIsIG9wdGlvbnMpIHtcbiAgICByZXR1cm4gdGhpcy5hZGQobWV0aG9kLCBwYXRoLCBoYW5kbGVyLCBvcHRpb25zKTtcbiAgfTtcbn0pO1xuXG5Sb3V0ZXIucHJvdG90eXBlLmFkZCA9IGZ1bmN0aW9uKG1ldGhvZCwgcGF0aCwgaGFuZGxlciwgb3B0aW9ucykge1xuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgdmFyIG9yaWdpbjtcblxuICBpZiAocGF0aCBpbnN0YW5jZW9mIFJlZ0V4cCkge1xuICAgIC8vIFdlIG5lZWQgYSB1bmlxdWUga2V5IHRvIHVzZSBpbiB0aGUgTWFwIHRvIGRpc3Rpbmd1aXNoIFJlZ0V4cCBwYXRoc1xuICAgIC8vIGZyb20gRXhwcmVzcy1zdHlsZSBwYXRocyArIG9yaWdpbnMuIFNpbmNlIHdlIGNhbiB1c2UgYW55IG9iamVjdCBhcyB0aGVcbiAgICAvLyBrZXkgaW4gYSBNYXAsIGxldCdzIHVzZSB0aGUgUmVnRXhwIGNvbnN0cnVjdG9yIVxuICAgIG9yaWdpbiA9IFJlZ0V4cDtcbiAgfSBlbHNlIHtcbiAgICBvcmlnaW4gPSBvcHRpb25zLm9yaWdpbiB8fCBzZWxmLmxvY2F0aW9uLm9yaWdpbjtcbiAgICBpZiAob3JpZ2luIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgICBvcmlnaW4gPSBvcmlnaW4uc291cmNlO1xuICAgIH0gZWxzZSB7XG4gICAgICBvcmlnaW4gPSByZWdleEVzY2FwZShvcmlnaW4pO1xuICAgIH1cbiAgfVxuXG4gIG1ldGhvZCA9IG1ldGhvZC50b0xvd2VyQ2FzZSgpO1xuXG4gIHZhciByb3V0ZSA9IG5ldyBSb3V0ZShtZXRob2QsIHBhdGgsIGhhbmRsZXIsIG9wdGlvbnMpO1xuXG4gIGlmICghdGhpcy5yb3V0ZXMuaGFzKG9yaWdpbikpIHtcbiAgICB0aGlzLnJvdXRlcy5zZXQob3JpZ2luLCBuZXcgTWFwKCkpO1xuICB9XG5cbiAgdmFyIG1ldGhvZE1hcCA9IHRoaXMucm91dGVzLmdldChvcmlnaW4pO1xuICBpZiAoIW1ldGhvZE1hcC5oYXMobWV0aG9kKSkge1xuICAgIG1ldGhvZE1hcC5zZXQobWV0aG9kLCBuZXcgTWFwKCkpO1xuICB9XG5cbiAgdmFyIHJvdXRlTWFwID0gbWV0aG9kTWFwLmdldChtZXRob2QpO1xuICB2YXIgcmVnRXhwID0gcm91dGUucmVnZXhwIHx8IHJvdXRlLmZ1bGxVcmxSZWdFeHA7XG4gIHJvdXRlTWFwLnNldChyZWdFeHAuc291cmNlLCByb3V0ZSk7XG59O1xuXG5Sb3V0ZXIucHJvdG90eXBlLm1hdGNoTWV0aG9kID0gZnVuY3Rpb24obWV0aG9kLCB1cmwpIHtcbiAgdmFyIHVybE9iamVjdCA9IG5ldyBVUkwodXJsKTtcbiAgdmFyIG9yaWdpbiA9IHVybE9iamVjdC5vcmlnaW47XG4gIHZhciBwYXRoID0gdXJsT2JqZWN0LnBhdGhuYW1lO1xuXG4gIC8vIFdlIHdhbnQgdG8gZmlyc3QgY2hlY2sgdG8gc2VlIGlmIHRoZXJlJ3MgYSBtYXRjaCBhZ2FpbnN0IGFueVxuICAvLyBcIkV4cHJlc3Mtc3R5bGVcIiByb3V0ZXMgKHN0cmluZyBmb3IgdGhlIHBhdGgsIFJlZ0V4cCBmb3IgdGhlIG9yaWdpbikuXG4gIC8vIENoZWNraW5nIGZvciBFeHByZXNzLXN0eWxlIG1hdGNoZXMgZmlyc3QgbWFpbnRhaW5zIHRoZSBsZWdhY3kgYmVoYXZpb3IuXG4gIC8vIElmIHRoZXJlJ3Mgbm8gbWF0Y2gsIHdlIG5leHQgY2hlY2sgZm9yIGEgbWF0Y2ggYWdhaW5zdCBhbnkgUmVnRXhwIHJvdXRlcyxcbiAgLy8gd2hlcmUgdGhlIFJlZ0V4cCBpbiBxdWVzdGlvbiBtYXRjaGVzIHRoZSBmdWxsIFVSTCAoYm90aCBvcmlnaW4gYW5kIHBhdGgpLlxuICByZXR1cm4gdGhpcy5fbWF0Y2gobWV0aG9kLCBrZXlNYXRjaCh0aGlzLnJvdXRlcywgb3JpZ2luKSwgcGF0aCkgfHxcbiAgICB0aGlzLl9tYXRjaChtZXRob2QsIFt0aGlzLnJvdXRlcy5nZXQoUmVnRXhwKV0sIHVybCk7XG59O1xuXG5Sb3V0ZXIucHJvdG90eXBlLl9tYXRjaCA9IGZ1bmN0aW9uKG1ldGhvZCwgbWV0aG9kTWFwcywgcGF0aE9yVXJsKSB7XG4gIGlmIChtZXRob2RNYXBzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBtZXRob2RNYXBzLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIG1ldGhvZE1hcCA9IG1ldGhvZE1hcHNbaV07XG4gICAgdmFyIHJvdXRlTWFwID0gbWV0aG9kTWFwICYmIG1ldGhvZE1hcC5nZXQobWV0aG9kLnRvTG93ZXJDYXNlKCkpO1xuICAgIGlmIChyb3V0ZU1hcCkge1xuICAgICAgdmFyIHJvdXRlcyA9IGtleU1hdGNoKHJvdXRlTWFwLCBwYXRoT3JVcmwpO1xuICAgICAgaWYgKHJvdXRlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHJldHVybiByb3V0ZXNbMF0ubWFrZUhhbmRsZXIocGF0aE9yVXJsKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn07XG5cblJvdXRlci5wcm90b3R5cGUubWF0Y2ggPSBmdW5jdGlvbihyZXF1ZXN0KSB7XG4gIHJldHVybiB0aGlzLm1hdGNoTWV0aG9kKHJlcXVlc3QubWV0aG9kLCByZXF1ZXN0LnVybCkgfHxcbiAgICAgIHRoaXMubWF0Y2hNZXRob2QoJ2FueScsIHJlcXVlc3QudXJsKTtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gbmV3IFJvdXRlcigpO1xuIiwiLypcblx0Q29weXJpZ2h0IDIwMTQgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cblxuXHRMaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xuXHR5b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG5cdFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuXG4gICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcblxuXHRVbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG5cdGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcblx0V0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG5cdFNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcblx0bGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4qL1xuJ3VzZSBzdHJpY3QnO1xudmFyIGhlbHBlcnMgPSByZXF1aXJlKCcuLi9oZWxwZXJzJyk7XG5cbmZ1bmN0aW9uIGNhY2hlRmlyc3QocmVxdWVzdCwgdmFsdWVzLCBvcHRpb25zKSB7XG4gIGhlbHBlcnMuZGVidWcoJ1N0cmF0ZWd5OiBjYWNoZSBmaXJzdCBbJyArIHJlcXVlc3QudXJsICsgJ10nLCBvcHRpb25zKTtcbiAgcmV0dXJuIGhlbHBlcnMub3BlbkNhY2hlKG9wdGlvbnMpLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICByZXR1cm4gY2FjaGUubWF0Y2gocmVxdWVzdCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGhlbHBlcnMuZmV0Y2hBbmRDYWNoZShyZXF1ZXN0LCBvcHRpb25zKTtcbiAgICB9KTtcbiAgfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gY2FjaGVGaXJzdDtcbiIsIi8qXG5cdENvcHlyaWdodCAyMDE0IEdvb2dsZSBJbmMuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuXG5cblx0TGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcblx0eW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuXHRZb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXRcblxuICAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG5cblx0VW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuXHRkaXN0cmlidXRlZCB1bmRlciB0aGUgTGljZW5zZSBpcyBkaXN0cmlidXRlZCBvbiBhbiBcIkFTIElTXCIgQkFTSVMsXG5cdFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuXHRTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG5cdGxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLlxuKi9cbid1c2Ugc3RyaWN0JztcbnZhciBoZWxwZXJzID0gcmVxdWlyZSgnLi4vaGVscGVycycpO1xuXG5mdW5jdGlvbiBjYWNoZU9ubHkocmVxdWVzdCwgdmFsdWVzLCBvcHRpb25zKSB7XG4gIGhlbHBlcnMuZGVidWcoJ1N0cmF0ZWd5OiBjYWNoZSBvbmx5IFsnICsgcmVxdWVzdC51cmwgKyAnXScsIG9wdGlvbnMpO1xuICByZXR1cm4gaGVscGVycy5vcGVuQ2FjaGUob3B0aW9ucykudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgIHJldHVybiBjYWNoZS5tYXRjaChyZXF1ZXN0KTtcbiAgfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gY2FjaGVPbmx5O1xuIiwiLypcbiAgQ29weXJpZ2h0IDIwMTQgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cblxuICBMaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xuICB5b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG4gIFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuXG4gICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcblxuICBVbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG4gIGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcbiAgV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG4gIFNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcbiAgbGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4qL1xuJ3VzZSBzdHJpY3QnO1xudmFyIGhlbHBlcnMgPSByZXF1aXJlKCcuLi9oZWxwZXJzJyk7XG52YXIgY2FjaGVPbmx5ID0gcmVxdWlyZSgnLi9jYWNoZU9ubHknKTtcblxuZnVuY3Rpb24gZmFzdGVzdChyZXF1ZXN0LCB2YWx1ZXMsIG9wdGlvbnMpIHtcbiAgaGVscGVycy5kZWJ1ZygnU3RyYXRlZ3k6IGZhc3Rlc3QgWycgKyByZXF1ZXN0LnVybCArICddJywgb3B0aW9ucyk7XG5cbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHZhciByZWplY3RlZCA9IGZhbHNlO1xuICAgIHZhciByZWFzb25zID0gW107XG5cbiAgICB2YXIgbWF5YmVSZWplY3QgPSBmdW5jdGlvbihyZWFzb24pIHtcbiAgICAgIHJlYXNvbnMucHVzaChyZWFzb24udG9TdHJpbmcoKSk7XG4gICAgICBpZiAocmVqZWN0ZWQpIHtcbiAgICAgICAgcmVqZWN0KG5ldyBFcnJvcignQm90aCBjYWNoZSBhbmQgbmV0d29yayBmYWlsZWQ6IFwiJyArXG4gICAgICAgICAgICByZWFzb25zLmpvaW4oJ1wiLCBcIicpICsgJ1wiJykpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmVqZWN0ZWQgPSB0cnVlO1xuICAgICAgfVxuICAgIH07XG5cbiAgICB2YXIgbWF5YmVSZXNvbHZlID0gZnVuY3Rpb24ocmVzdWx0KSB7XG4gICAgICBpZiAocmVzdWx0IGluc3RhbmNlb2YgUmVzcG9uc2UpIHtcbiAgICAgICAgcmVzb2x2ZShyZXN1bHQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbWF5YmVSZWplY3QoJ05vIHJlc3VsdCByZXR1cm5lZCcpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBoZWxwZXJzLmZldGNoQW5kQ2FjaGUocmVxdWVzdC5jbG9uZSgpLCBvcHRpb25zKVxuICAgICAgLnRoZW4obWF5YmVSZXNvbHZlLCBtYXliZVJlamVjdCk7XG5cbiAgICBjYWNoZU9ubHkocmVxdWVzdCwgdmFsdWVzLCBvcHRpb25zKVxuICAgICAgLnRoZW4obWF5YmVSZXNvbHZlLCBtYXliZVJlamVjdCk7XG4gIH0pO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGZhc3Rlc3Q7XG4iLCIvKlxuXHRDb3B5cmlnaHQgMjAxNCBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG5cdExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG5cdHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cblx0WW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG5cdFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcblx0ZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuXHRXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cblx0U2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuXHRsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgbmV0d29ya09ubHk6IHJlcXVpcmUoJy4vbmV0d29ya09ubHknKSxcbiAgbmV0d29ya0ZpcnN0OiByZXF1aXJlKCcuL25ldHdvcmtGaXJzdCcpLFxuICBjYWNoZU9ubHk6IHJlcXVpcmUoJy4vY2FjaGVPbmx5JyksXG4gIGNhY2hlRmlyc3Q6IHJlcXVpcmUoJy4vY2FjaGVGaXJzdCcpLFxuICBmYXN0ZXN0OiByZXF1aXJlKCcuL2Zhc3Rlc3QnKVxufTtcbiIsIi8qXG4gQ29weXJpZ2h0IDIwMTUgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cblxuIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG4geW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuIFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuXG4gICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG4gVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuIGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcbiBXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cbiBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gbGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4qL1xuJ3VzZSBzdHJpY3QnO1xudmFyIGdsb2JhbE9wdGlvbnMgPSByZXF1aXJlKCcuLi9vcHRpb25zJyk7XG52YXIgaGVscGVycyA9IHJlcXVpcmUoJy4uL2hlbHBlcnMnKTtcblxuZnVuY3Rpb24gbmV0d29ya0ZpcnN0KHJlcXVlc3QsIHZhbHVlcywgb3B0aW9ucykge1xuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgdmFyIHN1Y2Nlc3NSZXNwb25zZXMgPSBvcHRpb25zLnN1Y2Nlc3NSZXNwb25zZXMgfHxcbiAgICAgIGdsb2JhbE9wdGlvbnMuc3VjY2Vzc1Jlc3BvbnNlcztcbiAgLy8gVGhpcyB3aWxsIGJ5cGFzcyBvcHRpb25zLm5ldHdvcmtUaW1lb3V0IGlmIGl0J3Mgc2V0IHRvIGEgZmFsc2UteSB2YWx1ZSBsaWtlXG4gIC8vIDAsIGJ1dCB0aGF0J3MgdGhlIHNhbmUgdGhpbmcgdG8gZG8gYW55d2F5LlxuICB2YXIgbmV0d29ya1RpbWVvdXRTZWNvbmRzID0gb3B0aW9ucy5uZXR3b3JrVGltZW91dFNlY29uZHMgfHxcbiAgICAgIGdsb2JhbE9wdGlvbnMubmV0d29ya1RpbWVvdXRTZWNvbmRzO1xuICBoZWxwZXJzLmRlYnVnKCdTdHJhdGVneTogbmV0d29yayBmaXJzdCBbJyArIHJlcXVlc3QudXJsICsgJ10nLCBvcHRpb25zKTtcblxuICByZXR1cm4gaGVscGVycy5vcGVuQ2FjaGUob3B0aW9ucykudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgIHZhciB0aW1lb3V0SWQ7XG4gICAgdmFyIHByb21pc2VzID0gW107XG4gICAgdmFyIG9yaWdpbmFsUmVzcG9uc2U7XG5cbiAgICBpZiAobmV0d29ya1RpbWVvdXRTZWNvbmRzKSB7XG4gICAgICB2YXIgY2FjaGVXaGVuVGltZWRPdXRQcm9taXNlID0gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSkge1xuICAgICAgICB0aW1lb3V0SWQgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICAgIGNhY2hlLm1hdGNoKHJlcXVlc3QpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgICAgICAgIGlmIChyZXNwb25zZSkge1xuICAgICAgICAgICAgICAvLyBPbmx5IHJlc29sdmUgdGhpcyBwcm9taXNlIGlmIHRoZXJlJ3MgYSB2YWxpZCByZXNwb25zZSBpbiB0aGVcbiAgICAgICAgICAgICAgLy8gY2FjaGUuIFRoaXMgZW5zdXJlcyB0aGF0IHdlIHdvbid0IHRpbWUgb3V0IGEgbmV0d29yayByZXF1ZXN0XG4gICAgICAgICAgICAgIC8vIHVubGVzcyB0aGVyZSdzIGEgY2FjaGVkIGVudHJ5IHRvIGZhbGxiYWNrIG9uLCB3aGljaCBpcyBhcmd1YWJseVxuICAgICAgICAgICAgICAvLyB0aGUgcHJlZmVyYWJsZSBiZWhhdmlvci5cbiAgICAgICAgICAgICAgcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0sIG5ldHdvcmtUaW1lb3V0U2Vjb25kcyAqIDEwMDApO1xuICAgICAgfSk7XG4gICAgICBwcm9taXNlcy5wdXNoKGNhY2hlV2hlblRpbWVkT3V0UHJvbWlzZSk7XG4gICAgfVxuXG4gICAgdmFyIG5ldHdvcmtQcm9taXNlID0gaGVscGVycy5mZXRjaEFuZENhY2hlKHJlcXVlc3QsIG9wdGlvbnMpXG4gICAgICAudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgICAvLyBXZSd2ZSBnb3QgYSByZXNwb25zZSwgc28gY2xlYXIgdGhlIG5ldHdvcmsgdGltZW91dCBpZiB0aGVyZSBpcyBvbmUuXG4gICAgICAgIGlmICh0aW1lb3V0SWQpIHtcbiAgICAgICAgICBjbGVhclRpbWVvdXQodGltZW91dElkKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzdWNjZXNzUmVzcG9uc2VzLnRlc3QocmVzcG9uc2Uuc3RhdHVzKSkge1xuICAgICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGhlbHBlcnMuZGVidWcoJ1Jlc3BvbnNlIHdhcyBhbiBIVFRQIGVycm9yOiAnICsgcmVzcG9uc2Uuc3RhdHVzVGV4dCxcbiAgICAgICAgICAgIG9wdGlvbnMpO1xuICAgICAgICBvcmlnaW5hbFJlc3BvbnNlID0gcmVzcG9uc2U7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQmFkIHJlc3BvbnNlJyk7XG4gICAgICB9KS5jYXRjaChmdW5jdGlvbihlcnJvcikge1xuICAgICAgICBoZWxwZXJzLmRlYnVnKCdOZXR3b3JrIG9yIHJlc3BvbnNlIGVycm9yLCBmYWxsYmFjayB0byBjYWNoZSBbJyArXG4gICAgICAgICAgICByZXF1ZXN0LnVybCArICddJywgb3B0aW9ucyk7XG4gICAgICAgIHJldHVybiBjYWNoZS5tYXRjaChyZXF1ZXN0KS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICAgICAgLy8gSWYgdGhlcmUncyBhIG1hdGNoIGluIHRoZSBjYWNoZSwgcmVzb2x2ZSB3aXRoIHRoYXQuXG4gICAgICAgICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gSWYgd2UgaGF2ZSBhIFJlc3BvbnNlIG9iamVjdCBmcm9tIHRoZSBwcmV2aW91cyBmZXRjaCwgdGhlbiByZXNvbHZlXG4gICAgICAgICAgLy8gd2l0aCB0aGF0LCBldmVuIHRob3VnaCBpdCBjb3JyZXNwb25kcyB0byBhbiBlcnJvciBzdGF0dXMgY29kZS5cbiAgICAgICAgICBpZiAob3JpZ2luYWxSZXNwb25zZSkge1xuICAgICAgICAgICAgcmV0dXJuIG9yaWdpbmFsUmVzcG9uc2U7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gSWYgd2UgZG9uJ3QgaGF2ZSBhIFJlc3BvbnNlIG9iamVjdCBmcm9tIHRoZSBwcmV2aW91cyBmZXRjaCwgbGlrZWx5XG4gICAgICAgICAgLy8gZHVlIHRvIGEgbmV0d29yayBmYWlsdXJlLCB0aGVuIHJlamVjdCB3aXRoIHRoZSBmYWlsdXJlIGVycm9yLlxuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuXG4gICAgcHJvbWlzZXMucHVzaChuZXR3b3JrUHJvbWlzZSk7XG5cbiAgICByZXR1cm4gUHJvbWlzZS5yYWNlKHByb21pc2VzKTtcbiAgfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gbmV0d29ya0ZpcnN0O1xuIiwiLypcblx0Q29weXJpZ2h0IDIwMTQgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cblxuXHRMaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xuXHR5b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG5cdFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuXG4gICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcblxuXHRVbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG5cdGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcblx0V0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG5cdFNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcblx0bGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4qL1xuJ3VzZSBzdHJpY3QnO1xudmFyIGhlbHBlcnMgPSByZXF1aXJlKCcuLi9oZWxwZXJzJyk7XG5cbmZ1bmN0aW9uIG5ldHdvcmtPbmx5KHJlcXVlc3QsIHZhbHVlcywgb3B0aW9ucykge1xuICBoZWxwZXJzLmRlYnVnKCdTdHJhdGVneTogbmV0d29yayBvbmx5IFsnICsgcmVxdWVzdC51cmwgKyAnXScsIG9wdGlvbnMpO1xuICByZXR1cm4gZmV0Y2gocmVxdWVzdCk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gbmV0d29ya09ubHk7XG4iLCIvKlxuICBDb3B5cmlnaHQgMjAxNCBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG4gIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG4gIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cbiAgWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG4gIFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcbiAgZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICBXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cbiAgU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuICBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG4ndXNlIHN0cmljdCc7XG5cbnJlcXVpcmUoJ3NlcnZpY2V3b3JrZXItY2FjaGUtcG9seWZpbGwnKTtcbnZhciBvcHRpb25zID0gcmVxdWlyZSgnLi9vcHRpb25zJyk7XG52YXIgcm91dGVyID0gcmVxdWlyZSgnLi9yb3V0ZXInKTtcbnZhciBoZWxwZXJzID0gcmVxdWlyZSgnLi9oZWxwZXJzJyk7XG52YXIgc3RyYXRlZ2llcyA9IHJlcXVpcmUoJy4vc3RyYXRlZ2llcycpO1xuXG5oZWxwZXJzLmRlYnVnKCdTZXJ2aWNlIFdvcmtlciBUb29sYm94IGlzIGxvYWRpbmcnKTtcblxuLy8gSW5zdGFsbFxudmFyIGZsYXR0ZW4gPSBmdW5jdGlvbihpdGVtcykge1xuICByZXR1cm4gaXRlbXMucmVkdWNlKGZ1bmN0aW9uKGEsIGIpIHtcbiAgICByZXR1cm4gYS5jb25jYXQoYik7XG4gIH0sIFtdKTtcbn07XG5cbnZhciB2YWxpZGF0ZVByZWNhY2hlSW5wdXQgPSBmdW5jdGlvbihpdGVtcykge1xuICB2YXIgaXNWYWxpZCA9IEFycmF5LmlzQXJyYXkoaXRlbXMpO1xuICBpZiAoaXNWYWxpZCkge1xuICAgIGl0ZW1zLmZvckVhY2goZnVuY3Rpb24oaXRlbSkge1xuICAgICAgaWYgKCEodHlwZW9mIGl0ZW0gPT09ICdzdHJpbmcnIHx8IChpdGVtIGluc3RhbmNlb2YgUmVxdWVzdCkpKSB7XG4gICAgICAgIGlzVmFsaWQgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIGlmICghaXNWYWxpZCkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ1RoZSBwcmVjYWNoZSBtZXRob2QgZXhwZWN0cyBlaXRoZXIgYW4gYXJyYXkgb2YgJyArXG4gICAgJ3N0cmluZ3MgYW5kL29yIFJlcXVlc3RzIG9yIGEgUHJvbWlzZSB0aGF0IHJlc29sdmVzIHRvIGFuIGFycmF5IG9mICcgK1xuICAgICdzdHJpbmdzIGFuZC9vciBSZXF1ZXN0cy4nKTtcbiAgfVxuXG4gIHJldHVybiBpdGVtcztcbn07XG5cbnNlbGYuYWRkRXZlbnRMaXN0ZW5lcignaW5zdGFsbCcsIGZ1bmN0aW9uKGV2ZW50KSB7XG4gIHZhciBpbmFjdGl2ZUNhY2hlID0gb3B0aW9ucy5jYWNoZS5uYW1lICsgJyQkJGluYWN0aXZlJCQkJztcbiAgaGVscGVycy5kZWJ1ZygnaW5zdGFsbCBldmVudCBmaXJlZCcpO1xuICBoZWxwZXJzLmRlYnVnKCdjcmVhdGluZyBjYWNoZSBbJyArIGluYWN0aXZlQ2FjaGUgKyAnXScpO1xuICBldmVudC53YWl0VW50aWwoXG4gICAgaGVscGVycy5vcGVuQ2FjaGUoe2NhY2hlOiB7bmFtZTogaW5hY3RpdmVDYWNoZX19KVxuICAgIC50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwob3B0aW9ucy5wcmVDYWNoZUl0ZW1zKVxuICAgICAgLnRoZW4oZmxhdHRlbilcbiAgICAgIC50aGVuKHZhbGlkYXRlUHJlY2FjaGVJbnB1dClcbiAgICAgIC50aGVuKGZ1bmN0aW9uKHByZUNhY2hlSXRlbXMpIHtcbiAgICAgICAgaGVscGVycy5kZWJ1ZygncHJlQ2FjaGUgbGlzdDogJyArXG4gICAgICAgICAgICAocHJlQ2FjaGVJdGVtcy5qb2luKCcsICcpIHx8ICcobm9uZSknKSk7XG4gICAgICAgIHJldHVybiBjYWNoZS5hZGRBbGwocHJlQ2FjaGVJdGVtcyk7XG4gICAgICB9KTtcbiAgICB9KVxuICApO1xufSk7XG5cbi8vIEFjdGl2YXRlXG5cbnNlbGYuYWRkRXZlbnRMaXN0ZW5lcignYWN0aXZhdGUnLCBmdW5jdGlvbihldmVudCkge1xuICBoZWxwZXJzLmRlYnVnKCdhY3RpdmF0ZSBldmVudCBmaXJlZCcpO1xuICB2YXIgaW5hY3RpdmVDYWNoZSA9IG9wdGlvbnMuY2FjaGUubmFtZSArICckJCRpbmFjdGl2ZSQkJCc7XG4gIGV2ZW50LndhaXRVbnRpbChoZWxwZXJzLnJlbmFtZUNhY2hlKGluYWN0aXZlQ2FjaGUsIG9wdGlvbnMuY2FjaGUubmFtZSkpO1xufSk7XG5cbi8vIEZldGNoXG5cbnNlbGYuYWRkRXZlbnRMaXN0ZW5lcignZmV0Y2gnLCBmdW5jdGlvbihldmVudCkge1xuICB2YXIgaGFuZGxlciA9IHJvdXRlci5tYXRjaChldmVudC5yZXF1ZXN0KTtcblxuICBpZiAoaGFuZGxlcikge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKGhhbmRsZXIoZXZlbnQucmVxdWVzdCkpO1xuICB9IGVsc2UgaWYgKHJvdXRlci5kZWZhdWx0ICYmIGV2ZW50LnJlcXVlc3QubWV0aG9kID09PSAnR0VUJykge1xuICAgIGV2ZW50LnJlc3BvbmRXaXRoKHJvdXRlci5kZWZhdWx0KGV2ZW50LnJlcXVlc3QpKTtcbiAgfVxufSk7XG5cbi8vIENhY2hpbmdcblxuZnVuY3Rpb24gY2FjaGUodXJsLCBvcHRpb25zKSB7XG4gIHJldHVybiBoZWxwZXJzLm9wZW5DYWNoZShvcHRpb25zKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgcmV0dXJuIGNhY2hlLmFkZCh1cmwpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gdW5jYWNoZSh1cmwsIG9wdGlvbnMpIHtcbiAgcmV0dXJuIGhlbHBlcnMub3BlbkNhY2hlKG9wdGlvbnMpLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICByZXR1cm4gY2FjaGUuZGVsZXRlKHVybCk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBwcmVjYWNoZShpdGVtcykge1xuICBpZiAoIShpdGVtcyBpbnN0YW5jZW9mIFByb21pc2UpKSB7XG4gICAgdmFsaWRhdGVQcmVjYWNoZUlucHV0KGl0ZW1zKTtcbiAgfVxuXG4gIG9wdGlvbnMucHJlQ2FjaGVJdGVtcyA9IG9wdGlvbnMucHJlQ2FjaGVJdGVtcy5jb25jYXQoaXRlbXMpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgbmV0d29ya09ubHk6IHN0cmF0ZWdpZXMubmV0d29ya09ubHksXG4gIG5ldHdvcmtGaXJzdDogc3RyYXRlZ2llcy5uZXR3b3JrRmlyc3QsXG4gIGNhY2hlT25seTogc3RyYXRlZ2llcy5jYWNoZU9ubHksXG4gIGNhY2hlRmlyc3Q6IHN0cmF0ZWdpZXMuY2FjaGVGaXJzdCxcbiAgZmFzdGVzdDogc3RyYXRlZ2llcy5mYXN0ZXN0LFxuICByb3V0ZXI6IHJvdXRlcixcbiAgb3B0aW9uczogb3B0aW9ucyxcbiAgY2FjaGU6IGNhY2hlLFxuICB1bmNhY2hlOiB1bmNhY2hlLFxuICBwcmVjYWNoZTogcHJlY2FjaGVcbn07XG4iLCJ2YXIgaXNhcnJheSA9IHJlcXVpcmUoJ2lzYXJyYXknKVxuXG4vKipcbiAqIEV4cG9zZSBgcGF0aFRvUmVnZXhwYC5cbiAqL1xubW9kdWxlLmV4cG9ydHMgPSBwYXRoVG9SZWdleHBcbm1vZHVsZS5leHBvcnRzLnBhcnNlID0gcGFyc2Vcbm1vZHVsZS5leHBvcnRzLmNvbXBpbGUgPSBjb21waWxlXG5tb2R1bGUuZXhwb3J0cy50b2tlbnNUb0Z1bmN0aW9uID0gdG9rZW5zVG9GdW5jdGlvblxubW9kdWxlLmV4cG9ydHMudG9rZW5zVG9SZWdFeHAgPSB0b2tlbnNUb1JlZ0V4cFxuXG4vKipcbiAqIFRoZSBtYWluIHBhdGggbWF0Y2hpbmcgcmVnZXhwIHV0aWxpdHkuXG4gKlxuICogQHR5cGUge1JlZ0V4cH1cbiAqL1xudmFyIFBBVEhfUkVHRVhQID0gbmV3IFJlZ0V4cChbXG4gIC8vIE1hdGNoIGVzY2FwZWQgY2hhcmFjdGVycyB0aGF0IHdvdWxkIG90aGVyd2lzZSBhcHBlYXIgaW4gZnV0dXJlIG1hdGNoZXMuXG4gIC8vIFRoaXMgYWxsb3dzIHRoZSB1c2VyIHRvIGVzY2FwZSBzcGVjaWFsIGNoYXJhY3RlcnMgdGhhdCB3b24ndCB0cmFuc2Zvcm0uXG4gICcoXFxcXFxcXFwuKScsXG4gIC8vIE1hdGNoIEV4cHJlc3Mtc3R5bGUgcGFyYW1ldGVycyBhbmQgdW4tbmFtZWQgcGFyYW1ldGVycyB3aXRoIGEgcHJlZml4XG4gIC8vIGFuZCBvcHRpb25hbCBzdWZmaXhlcy4gTWF0Y2hlcyBhcHBlYXIgYXM6XG4gIC8vXG4gIC8vIFwiLzp0ZXN0KFxcXFxkKyk/XCIgPT4gW1wiL1wiLCBcInRlc3RcIiwgXCJcXGQrXCIsIHVuZGVmaW5lZCwgXCI/XCIsIHVuZGVmaW5lZF1cbiAgLy8gXCIvcm91dGUoXFxcXGQrKVwiICA9PiBbdW5kZWZpbmVkLCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgXCJcXGQrXCIsIHVuZGVmaW5lZCwgdW5kZWZpbmVkXVxuICAvLyBcIi8qXCIgICAgICAgICAgICA9PiBbXCIvXCIsIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgXCIqXCJdXG4gICcoW1xcXFwvLl0pPyg/Oig/OlxcXFw6KFxcXFx3KykoPzpcXFxcKCgoPzpcXFxcXFxcXC58W15cXFxcXFxcXCgpXSkrKVxcXFwpKT98XFxcXCgoKD86XFxcXFxcXFwufFteXFxcXFxcXFwoKV0pKylcXFxcKSkoWysqP10pP3woXFxcXCopKSdcbl0uam9pbignfCcpLCAnZycpXG5cbi8qKlxuICogUGFyc2UgYSBzdHJpbmcgZm9yIHRoZSByYXcgdG9rZW5zLlxuICpcbiAqIEBwYXJhbSAge3N0cmluZ30gc3RyXG4gKiBAcmV0dXJuIHshQXJyYXl9XG4gKi9cbmZ1bmN0aW9uIHBhcnNlIChzdHIpIHtcbiAgdmFyIHRva2VucyA9IFtdXG4gIHZhciBrZXkgPSAwXG4gIHZhciBpbmRleCA9IDBcbiAgdmFyIHBhdGggPSAnJ1xuICB2YXIgcmVzXG5cbiAgd2hpbGUgKChyZXMgPSBQQVRIX1JFR0VYUC5leGVjKHN0cikpICE9IG51bGwpIHtcbiAgICB2YXIgbSA9IHJlc1swXVxuICAgIHZhciBlc2NhcGVkID0gcmVzWzFdXG4gICAgdmFyIG9mZnNldCA9IHJlcy5pbmRleFxuICAgIHBhdGggKz0gc3RyLnNsaWNlKGluZGV4LCBvZmZzZXQpXG4gICAgaW5kZXggPSBvZmZzZXQgKyBtLmxlbmd0aFxuXG4gICAgLy8gSWdub3JlIGFscmVhZHkgZXNjYXBlZCBzZXF1ZW5jZXMuXG4gICAgaWYgKGVzY2FwZWQpIHtcbiAgICAgIHBhdGggKz0gZXNjYXBlZFsxXVxuICAgICAgY29udGludWVcbiAgICB9XG5cbiAgICB2YXIgbmV4dCA9IHN0cltpbmRleF1cbiAgICB2YXIgcHJlZml4ID0gcmVzWzJdXG4gICAgdmFyIG5hbWUgPSByZXNbM11cbiAgICB2YXIgY2FwdHVyZSA9IHJlc1s0XVxuICAgIHZhciBncm91cCA9IHJlc1s1XVxuICAgIHZhciBtb2RpZmllciA9IHJlc1s2XVxuICAgIHZhciBhc3RlcmlzayA9IHJlc1s3XVxuXG4gICAgLy8gUHVzaCB0aGUgY3VycmVudCBwYXRoIG9udG8gdGhlIHRva2Vucy5cbiAgICBpZiAocGF0aCkge1xuICAgICAgdG9rZW5zLnB1c2gocGF0aClcbiAgICAgIHBhdGggPSAnJ1xuICAgIH1cblxuICAgIHZhciBwYXJ0aWFsID0gcHJlZml4ICE9IG51bGwgJiYgbmV4dCAhPSBudWxsICYmIG5leHQgIT09IHByZWZpeFxuICAgIHZhciByZXBlYXQgPSBtb2RpZmllciA9PT0gJysnIHx8IG1vZGlmaWVyID09PSAnKidcbiAgICB2YXIgb3B0aW9uYWwgPSBtb2RpZmllciA9PT0gJz8nIHx8IG1vZGlmaWVyID09PSAnKidcbiAgICB2YXIgZGVsaW1pdGVyID0gcmVzWzJdIHx8ICcvJ1xuICAgIHZhciBwYXR0ZXJuID0gY2FwdHVyZSB8fCBncm91cCB8fCAoYXN0ZXJpc2sgPyAnLionIDogJ1teJyArIGRlbGltaXRlciArICddKz8nKVxuXG4gICAgdG9rZW5zLnB1c2goe1xuICAgICAgbmFtZTogbmFtZSB8fCBrZXkrKyxcbiAgICAgIHByZWZpeDogcHJlZml4IHx8ICcnLFxuICAgICAgZGVsaW1pdGVyOiBkZWxpbWl0ZXIsXG4gICAgICBvcHRpb25hbDogb3B0aW9uYWwsXG4gICAgICByZXBlYXQ6IHJlcGVhdCxcbiAgICAgIHBhcnRpYWw6IHBhcnRpYWwsXG4gICAgICBhc3RlcmlzazogISFhc3RlcmlzayxcbiAgICAgIHBhdHRlcm46IGVzY2FwZUdyb3VwKHBhdHRlcm4pXG4gICAgfSlcbiAgfVxuXG4gIC8vIE1hdGNoIGFueSBjaGFyYWN0ZXJzIHN0aWxsIHJlbWFpbmluZy5cbiAgaWYgKGluZGV4IDwgc3RyLmxlbmd0aCkge1xuICAgIHBhdGggKz0gc3RyLnN1YnN0cihpbmRleClcbiAgfVxuXG4gIC8vIElmIHRoZSBwYXRoIGV4aXN0cywgcHVzaCBpdCBvbnRvIHRoZSBlbmQuXG4gIGlmIChwYXRoKSB7XG4gICAgdG9rZW5zLnB1c2gocGF0aClcbiAgfVxuXG4gIHJldHVybiB0b2tlbnNcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgc3RyaW5nIHRvIGEgdGVtcGxhdGUgZnVuY3Rpb24gZm9yIHRoZSBwYXRoLlxuICpcbiAqIEBwYXJhbSAge3N0cmluZ30gICAgICAgICAgICAgc3RyXG4gKiBAcmV0dXJuIHshZnVuY3Rpb24oT2JqZWN0PSwgT2JqZWN0PSl9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGUgKHN0cikge1xuICByZXR1cm4gdG9rZW5zVG9GdW5jdGlvbihwYXJzZShzdHIpKVxufVxuXG4vKipcbiAqIFByZXR0aWVyIGVuY29kaW5nIG9mIFVSSSBwYXRoIHNlZ21lbnRzLlxuICpcbiAqIEBwYXJhbSAge3N0cmluZ31cbiAqIEByZXR1cm4ge3N0cmluZ31cbiAqL1xuZnVuY3Rpb24gZW5jb2RlVVJJQ29tcG9uZW50UHJldHR5IChzdHIpIHtcbiAgcmV0dXJuIGVuY29kZVVSSShzdHIpLnJlcGxhY2UoL1tcXC8/I10vZywgZnVuY3Rpb24gKGMpIHtcbiAgICByZXR1cm4gJyUnICsgYy5jaGFyQ29kZUF0KDApLnRvU3RyaW5nKDE2KS50b1VwcGVyQ2FzZSgpXG4gIH0pXG59XG5cbi8qKlxuICogRW5jb2RlIHRoZSBhc3RlcmlzayBwYXJhbWV0ZXIuIFNpbWlsYXIgdG8gYHByZXR0eWAsIGJ1dCBhbGxvd3Mgc2xhc2hlcy5cbiAqXG4gKiBAcGFyYW0gIHtzdHJpbmd9XG4gKiBAcmV0dXJuIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGVuY29kZUFzdGVyaXNrIChzdHIpIHtcbiAgcmV0dXJuIGVuY29kZVVSSShzdHIpLnJlcGxhY2UoL1s/I10vZywgZnVuY3Rpb24gKGMpIHtcbiAgICByZXR1cm4gJyUnICsgYy5jaGFyQ29kZUF0KDApLnRvU3RyaW5nKDE2KS50b1VwcGVyQ2FzZSgpXG4gIH0pXG59XG5cbi8qKlxuICogRXhwb3NlIGEgbWV0aG9kIGZvciB0cmFuc2Zvcm1pbmcgdG9rZW5zIGludG8gdGhlIHBhdGggZnVuY3Rpb24uXG4gKi9cbmZ1bmN0aW9uIHRva2Vuc1RvRnVuY3Rpb24gKHRva2Vucykge1xuICAvLyBDb21waWxlIGFsbCB0aGUgdG9rZW5zIGludG8gcmVnZXhwcy5cbiAgdmFyIG1hdGNoZXMgPSBuZXcgQXJyYXkodG9rZW5zLmxlbmd0aClcblxuICAvLyBDb21waWxlIGFsbCB0aGUgcGF0dGVybnMgYmVmb3JlIGNvbXBpbGF0aW9uLlxuICBmb3IgKHZhciBpID0gMDsgaSA8IHRva2Vucy5sZW5ndGg7IGkrKykge1xuICAgIGlmICh0eXBlb2YgdG9rZW5zW2ldID09PSAnb2JqZWN0Jykge1xuICAgICAgbWF0Y2hlc1tpXSA9IG5ldyBSZWdFeHAoJ14oPzonICsgdG9rZW5zW2ldLnBhdHRlcm4gKyAnKSQnKVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmdW5jdGlvbiAob2JqLCBvcHRzKSB7XG4gICAgdmFyIHBhdGggPSAnJ1xuICAgIHZhciBkYXRhID0gb2JqIHx8IHt9XG4gICAgdmFyIG9wdGlvbnMgPSBvcHRzIHx8IHt9XG4gICAgdmFyIGVuY29kZSA9IG9wdGlvbnMucHJldHR5ID8gZW5jb2RlVVJJQ29tcG9uZW50UHJldHR5IDogZW5jb2RlVVJJQ29tcG9uZW50XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRva2Vucy5sZW5ndGg7IGkrKykge1xuICAgICAgdmFyIHRva2VuID0gdG9rZW5zW2ldXG5cbiAgICAgIGlmICh0eXBlb2YgdG9rZW4gPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHBhdGggKz0gdG9rZW5cblxuICAgICAgICBjb250aW51ZVxuICAgICAgfVxuXG4gICAgICB2YXIgdmFsdWUgPSBkYXRhW3Rva2VuLm5hbWVdXG4gICAgICB2YXIgc2VnbWVudFxuXG4gICAgICBpZiAodmFsdWUgPT0gbnVsbCkge1xuICAgICAgICBpZiAodG9rZW4ub3B0aW9uYWwpIHtcbiAgICAgICAgICAvLyBQcmVwZW5kIHBhcnRpYWwgc2VnbWVudCBwcmVmaXhlcy5cbiAgICAgICAgICBpZiAodG9rZW4ucGFydGlhbCkge1xuICAgICAgICAgICAgcGF0aCArPSB0b2tlbi5wcmVmaXhcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb250aW51ZVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0V4cGVjdGVkIFwiJyArIHRva2VuLm5hbWUgKyAnXCIgdG8gYmUgZGVmaW5lZCcpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKGlzYXJyYXkodmFsdWUpKSB7XG4gICAgICAgIGlmICghdG9rZW4ucmVwZWF0KSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignRXhwZWN0ZWQgXCInICsgdG9rZW4ubmFtZSArICdcIiB0byBub3QgcmVwZWF0LCBidXQgcmVjZWl2ZWQgYCcgKyBKU09OLnN0cmluZ2lmeSh2YWx1ZSkgKyAnYCcpXG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgaWYgKHRva2VuLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICBjb250aW51ZVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdFeHBlY3RlZCBcIicgKyB0b2tlbi5uYW1lICsgJ1wiIHRvIG5vdCBiZSBlbXB0eScpXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCB2YWx1ZS5sZW5ndGg7IGorKykge1xuICAgICAgICAgIHNlZ21lbnQgPSBlbmNvZGUodmFsdWVbal0pXG5cbiAgICAgICAgICBpZiAoIW1hdGNoZXNbaV0udGVzdChzZWdtZW50KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignRXhwZWN0ZWQgYWxsIFwiJyArIHRva2VuLm5hbWUgKyAnXCIgdG8gbWF0Y2ggXCInICsgdG9rZW4ucGF0dGVybiArICdcIiwgYnV0IHJlY2VpdmVkIGAnICsgSlNPTi5zdHJpbmdpZnkoc2VnbWVudCkgKyAnYCcpXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcGF0aCArPSAoaiA9PT0gMCA/IHRva2VuLnByZWZpeCA6IHRva2VuLmRlbGltaXRlcikgKyBzZWdtZW50XG4gICAgICAgIH1cblxuICAgICAgICBjb250aW51ZVxuICAgICAgfVxuXG4gICAgICBzZWdtZW50ID0gdG9rZW4uYXN0ZXJpc2sgPyBlbmNvZGVBc3Rlcmlzayh2YWx1ZSkgOiBlbmNvZGUodmFsdWUpXG5cbiAgICAgIGlmICghbWF0Y2hlc1tpXS50ZXN0KHNlZ21lbnQpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0V4cGVjdGVkIFwiJyArIHRva2VuLm5hbWUgKyAnXCIgdG8gbWF0Y2ggXCInICsgdG9rZW4ucGF0dGVybiArICdcIiwgYnV0IHJlY2VpdmVkIFwiJyArIHNlZ21lbnQgKyAnXCInKVxuICAgICAgfVxuXG4gICAgICBwYXRoICs9IHRva2VuLnByZWZpeCArIHNlZ21lbnRcbiAgICB9XG5cbiAgICByZXR1cm4gcGF0aFxuICB9XG59XG5cbi8qKlxuICogRXNjYXBlIGEgcmVndWxhciBleHByZXNzaW9uIHN0cmluZy5cbiAqXG4gKiBAcGFyYW0gIHtzdHJpbmd9IHN0clxuICogQHJldHVybiB7c3RyaW5nfVxuICovXG5mdW5jdGlvbiBlc2NhcGVTdHJpbmcgKHN0cikge1xuICByZXR1cm4gc3RyLnJlcGxhY2UoLyhbLisqPz1eIToke30oKVtcXF18XFwvXFxcXF0pL2csICdcXFxcJDEnKVxufVxuXG4vKipcbiAqIEVzY2FwZSB0aGUgY2FwdHVyaW5nIGdyb3VwIGJ5IGVzY2FwaW5nIHNwZWNpYWwgY2hhcmFjdGVycyBhbmQgbWVhbmluZy5cbiAqXG4gKiBAcGFyYW0gIHtzdHJpbmd9IGdyb3VwXG4gKiBAcmV0dXJuIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGVzY2FwZUdyb3VwIChncm91cCkge1xuICByZXR1cm4gZ3JvdXAucmVwbGFjZSgvKFs9ITokXFwvKCldKS9nLCAnXFxcXCQxJylcbn1cblxuLyoqXG4gKiBBdHRhY2ggdGhlIGtleXMgYXMgYSBwcm9wZXJ0eSBvZiB0aGUgcmVnZXhwLlxuICpcbiAqIEBwYXJhbSAgeyFSZWdFeHB9IHJlXG4gKiBAcGFyYW0gIHtBcnJheX0gICBrZXlzXG4gKiBAcmV0dXJuIHshUmVnRXhwfVxuICovXG5mdW5jdGlvbiBhdHRhY2hLZXlzIChyZSwga2V5cykge1xuICByZS5rZXlzID0ga2V5c1xuICByZXR1cm4gcmVcbn1cblxuLyoqXG4gKiBHZXQgdGhlIGZsYWdzIGZvciBhIHJlZ2V4cCBmcm9tIHRoZSBvcHRpb25zLlxuICpcbiAqIEBwYXJhbSAge09iamVjdH0gb3B0aW9uc1xuICogQHJldHVybiB7c3RyaW5nfVxuICovXG5mdW5jdGlvbiBmbGFncyAob3B0aW9ucykge1xuICByZXR1cm4gb3B0aW9ucy5zZW5zaXRpdmUgPyAnJyA6ICdpJ1xufVxuXG4vKipcbiAqIFB1bGwgb3V0IGtleXMgZnJvbSBhIHJlZ2V4cC5cbiAqXG4gKiBAcGFyYW0gIHshUmVnRXhwfSBwYXRoXG4gKiBAcGFyYW0gIHshQXJyYXl9ICBrZXlzXG4gKiBAcmV0dXJuIHshUmVnRXhwfVxuICovXG5mdW5jdGlvbiByZWdleHBUb1JlZ2V4cCAocGF0aCwga2V5cykge1xuICAvLyBVc2UgYSBuZWdhdGl2ZSBsb29rYWhlYWQgdG8gbWF0Y2ggb25seSBjYXB0dXJpbmcgZ3JvdXBzLlxuICB2YXIgZ3JvdXBzID0gcGF0aC5zb3VyY2UubWF0Y2goL1xcKCg/IVxcPykvZylcblxuICBpZiAoZ3JvdXBzKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBncm91cHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGtleXMucHVzaCh7XG4gICAgICAgIG5hbWU6IGksXG4gICAgICAgIHByZWZpeDogbnVsbCxcbiAgICAgICAgZGVsaW1pdGVyOiBudWxsLFxuICAgICAgICBvcHRpb25hbDogZmFsc2UsXG4gICAgICAgIHJlcGVhdDogZmFsc2UsXG4gICAgICAgIHBhcnRpYWw6IGZhbHNlLFxuICAgICAgICBhc3RlcmlzazogZmFsc2UsXG4gICAgICAgIHBhdHRlcm46IG51bGxcbiAgICAgIH0pXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGF0dGFjaEtleXMocGF0aCwga2V5cylcbn1cblxuLyoqXG4gKiBUcmFuc2Zvcm0gYW4gYXJyYXkgaW50byBhIHJlZ2V4cC5cbiAqXG4gKiBAcGFyYW0gIHshQXJyYXl9ICBwYXRoXG4gKiBAcGFyYW0gIHtBcnJheX0gICBrZXlzXG4gKiBAcGFyYW0gIHshT2JqZWN0fSBvcHRpb25zXG4gKiBAcmV0dXJuIHshUmVnRXhwfVxuICovXG5mdW5jdGlvbiBhcnJheVRvUmVnZXhwIChwYXRoLCBrZXlzLCBvcHRpb25zKSB7XG4gIHZhciBwYXJ0cyA9IFtdXG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBwYXRoLmxlbmd0aDsgaSsrKSB7XG4gICAgcGFydHMucHVzaChwYXRoVG9SZWdleHAocGF0aFtpXSwga2V5cywgb3B0aW9ucykuc291cmNlKVxuICB9XG5cbiAgdmFyIHJlZ2V4cCA9IG5ldyBSZWdFeHAoJyg/OicgKyBwYXJ0cy5qb2luKCd8JykgKyAnKScsIGZsYWdzKG9wdGlvbnMpKVxuXG4gIHJldHVybiBhdHRhY2hLZXlzKHJlZ2V4cCwga2V5cylcbn1cblxuLyoqXG4gKiBDcmVhdGUgYSBwYXRoIHJlZ2V4cCBmcm9tIHN0cmluZyBpbnB1dC5cbiAqXG4gKiBAcGFyYW0gIHtzdHJpbmd9ICBwYXRoXG4gKiBAcGFyYW0gIHshQXJyYXl9ICBrZXlzXG4gKiBAcGFyYW0gIHshT2JqZWN0fSBvcHRpb25zXG4gKiBAcmV0dXJuIHshUmVnRXhwfVxuICovXG5mdW5jdGlvbiBzdHJpbmdUb1JlZ2V4cCAocGF0aCwga2V5cywgb3B0aW9ucykge1xuICB2YXIgdG9rZW5zID0gcGFyc2UocGF0aClcbiAgdmFyIHJlID0gdG9rZW5zVG9SZWdFeHAodG9rZW5zLCBvcHRpb25zKVxuXG4gIC8vIEF0dGFjaCBrZXlzIGJhY2sgdG8gdGhlIHJlZ2V4cC5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCB0b2tlbnMubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAodHlwZW9mIHRva2Vuc1tpXSAhPT0gJ3N0cmluZycpIHtcbiAgICAgIGtleXMucHVzaCh0b2tlbnNbaV0pXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGF0dGFjaEtleXMocmUsIGtleXMpXG59XG5cbi8qKlxuICogRXhwb3NlIGEgZnVuY3Rpb24gZm9yIHRha2luZyB0b2tlbnMgYW5kIHJldHVybmluZyBhIFJlZ0V4cC5cbiAqXG4gKiBAcGFyYW0gIHshQXJyYXl9ICB0b2tlbnNcbiAqIEBwYXJhbSAge09iamVjdD19IG9wdGlvbnNcbiAqIEByZXR1cm4geyFSZWdFeHB9XG4gKi9cbmZ1bmN0aW9uIHRva2Vuc1RvUmVnRXhwICh0b2tlbnMsIG9wdGlvbnMpIHtcbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge31cblxuICB2YXIgc3RyaWN0ID0gb3B0aW9ucy5zdHJpY3RcbiAgdmFyIGVuZCA9IG9wdGlvbnMuZW5kICE9PSBmYWxzZVxuICB2YXIgcm91dGUgPSAnJ1xuICB2YXIgbGFzdFRva2VuID0gdG9rZW5zW3Rva2Vucy5sZW5ndGggLSAxXVxuICB2YXIgZW5kc1dpdGhTbGFzaCA9IHR5cGVvZiBsYXN0VG9rZW4gPT09ICdzdHJpbmcnICYmIC9cXC8kLy50ZXN0KGxhc3RUb2tlbilcblxuICAvLyBJdGVyYXRlIG92ZXIgdGhlIHRva2VucyBhbmQgY3JlYXRlIG91ciByZWdleHAgc3RyaW5nLlxuICBmb3IgKHZhciBpID0gMDsgaSA8IHRva2Vucy5sZW5ndGg7IGkrKykge1xuICAgIHZhciB0b2tlbiA9IHRva2Vuc1tpXVxuXG4gICAgaWYgKHR5cGVvZiB0b2tlbiA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJvdXRlICs9IGVzY2FwZVN0cmluZyh0b2tlbilcbiAgICB9IGVsc2Uge1xuICAgICAgdmFyIHByZWZpeCA9IGVzY2FwZVN0cmluZyh0b2tlbi5wcmVmaXgpXG4gICAgICB2YXIgY2FwdHVyZSA9ICcoPzonICsgdG9rZW4ucGF0dGVybiArICcpJ1xuXG4gICAgICBpZiAodG9rZW4ucmVwZWF0KSB7XG4gICAgICAgIGNhcHR1cmUgKz0gJyg/OicgKyBwcmVmaXggKyBjYXB0dXJlICsgJykqJ1xuICAgICAgfVxuXG4gICAgICBpZiAodG9rZW4ub3B0aW9uYWwpIHtcbiAgICAgICAgaWYgKCF0b2tlbi5wYXJ0aWFsKSB7XG4gICAgICAgICAgY2FwdHVyZSA9ICcoPzonICsgcHJlZml4ICsgJygnICsgY2FwdHVyZSArICcpKT8nXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY2FwdHVyZSA9IHByZWZpeCArICcoJyArIGNhcHR1cmUgKyAnKT8nXG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNhcHR1cmUgPSBwcmVmaXggKyAnKCcgKyBjYXB0dXJlICsgJyknXG4gICAgICB9XG5cbiAgICAgIHJvdXRlICs9IGNhcHR1cmVcbiAgICB9XG4gIH1cblxuICAvLyBJbiBub24tc3RyaWN0IG1vZGUgd2UgYWxsb3cgYSBzbGFzaCBhdCB0aGUgZW5kIG9mIG1hdGNoLiBJZiB0aGUgcGF0aCB0b1xuICAvLyBtYXRjaCBhbHJlYWR5IGVuZHMgd2l0aCBhIHNsYXNoLCB3ZSByZW1vdmUgaXQgZm9yIGNvbnNpc3RlbmN5LiBUaGUgc2xhc2hcbiAgLy8gaXMgdmFsaWQgYXQgdGhlIGVuZCBvZiBhIHBhdGggbWF0Y2gsIG5vdCBpbiB0aGUgbWlkZGxlLiBUaGlzIGlzIGltcG9ydGFudFxuICAvLyBpbiBub24tZW5kaW5nIG1vZGUsIHdoZXJlIFwiL3Rlc3QvXCIgc2hvdWxkbid0IG1hdGNoIFwiL3Rlc3QvL3JvdXRlXCIuXG4gIGlmICghc3RyaWN0KSB7XG4gICAgcm91dGUgPSAoZW5kc1dpdGhTbGFzaCA/IHJvdXRlLnNsaWNlKDAsIC0yKSA6IHJvdXRlKSArICcoPzpcXFxcLyg/PSQpKT8nXG4gIH1cblxuICBpZiAoZW5kKSB7XG4gICAgcm91dGUgKz0gJyQnXG4gIH0gZWxzZSB7XG4gICAgLy8gSW4gbm9uLWVuZGluZyBtb2RlLCB3ZSBuZWVkIHRoZSBjYXB0dXJpbmcgZ3JvdXBzIHRvIG1hdGNoIGFzIG11Y2ggYXNcbiAgICAvLyBwb3NzaWJsZSBieSB1c2luZyBhIHBvc2l0aXZlIGxvb2thaGVhZCB0byB0aGUgZW5kIG9yIG5leHQgcGF0aCBzZWdtZW50LlxuICAgIHJvdXRlICs9IHN0cmljdCAmJiBlbmRzV2l0aFNsYXNoID8gJycgOiAnKD89XFxcXC98JCknXG4gIH1cblxuICByZXR1cm4gbmV3IFJlZ0V4cCgnXicgKyByb3V0ZSwgZmxhZ3Mob3B0aW9ucykpXG59XG5cbi8qKlxuICogTm9ybWFsaXplIHRoZSBnaXZlbiBwYXRoIHN0cmluZywgcmV0dXJuaW5nIGEgcmVndWxhciBleHByZXNzaW9uLlxuICpcbiAqIEFuIGVtcHR5IGFycmF5IGNhbiBiZSBwYXNzZWQgaW4gZm9yIHRoZSBrZXlzLCB3aGljaCB3aWxsIGhvbGQgdGhlXG4gKiBwbGFjZWhvbGRlciBrZXkgZGVzY3JpcHRpb25zLiBGb3IgZXhhbXBsZSwgdXNpbmcgYC91c2VyLzppZGAsIGBrZXlzYCB3aWxsXG4gKiBjb250YWluIGBbeyBuYW1lOiAnaWQnLCBkZWxpbWl0ZXI6ICcvJywgb3B0aW9uYWw6IGZhbHNlLCByZXBlYXQ6IGZhbHNlIH1dYC5cbiAqXG4gKiBAcGFyYW0gIHsoc3RyaW5nfFJlZ0V4cHxBcnJheSl9IHBhdGhcbiAqIEBwYXJhbSAgeyhBcnJheXxPYmplY3QpPX0gICAgICAga2V5c1xuICogQHBhcmFtICB7T2JqZWN0PX0gICAgICAgICAgICAgICBvcHRpb25zXG4gKiBAcmV0dXJuIHshUmVnRXhwfVxuICovXG5mdW5jdGlvbiBwYXRoVG9SZWdleHAgKHBhdGgsIGtleXMsIG9wdGlvbnMpIHtcbiAga2V5cyA9IGtleXMgfHwgW11cblxuICBpZiAoIWlzYXJyYXkoa2V5cykpIHtcbiAgICBvcHRpb25zID0gLyoqIEB0eXBlIHshT2JqZWN0fSAqLyAoa2V5cylcbiAgICBrZXlzID0gW11cbiAgfSBlbHNlIGlmICghb3B0aW9ucykge1xuICAgIG9wdGlvbnMgPSB7fVxuICB9XG5cbiAgaWYgKHBhdGggaW5zdGFuY2VvZiBSZWdFeHApIHtcbiAgICByZXR1cm4gcmVnZXhwVG9SZWdleHAocGF0aCwgLyoqIEB0eXBlIHshQXJyYXl9ICovIChrZXlzKSlcbiAgfVxuXG4gIGlmIChpc2FycmF5KHBhdGgpKSB7XG4gICAgcmV0dXJuIGFycmF5VG9SZWdleHAoLyoqIEB0eXBlIHshQXJyYXl9ICovIChwYXRoKSwgLyoqIEB0eXBlIHshQXJyYXl9ICovIChrZXlzKSwgb3B0aW9ucylcbiAgfVxuXG4gIHJldHVybiBzdHJpbmdUb1JlZ2V4cCgvKiogQHR5cGUge3N0cmluZ30gKi8gKHBhdGgpLCAvKiogQHR5cGUgeyFBcnJheX0gKi8gKGtleXMpLCBvcHRpb25zKVxufVxuIiwibW9kdWxlLmV4cG9ydHMgPSBBcnJheS5pc0FycmF5IHx8IGZ1bmN0aW9uIChhcnIpIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChhcnIpID09ICdbb2JqZWN0IEFycmF5XSc7XG59O1xuIiwiLyoqXG4gKiBDb3B5cmlnaHQgMjAxNSBHb29nbGUgSW5jLiBBbGwgcmlnaHRzIHJlc2VydmVkLlxuICpcbiAqIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG4gKiB5b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG4gKiBZb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXRcbiAqXG4gKiAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG4gKlxuICogVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuICogZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICogV0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG4gKiBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gKiBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiAqXG4gKi9cblxuKGZ1bmN0aW9uKCkge1xuICB2YXIgbmF0aXZlQWRkQWxsID0gQ2FjaGUucHJvdG90eXBlLmFkZEFsbDtcbiAgdmFyIHVzZXJBZ2VudCA9IG5hdmlnYXRvci51c2VyQWdlbnQubWF0Y2goLyhGaXJlZm94fENocm9tZSlcXC8oXFxkK1xcLikvKTtcblxuICAvLyBIYXMgbmljZSBiZWhhdmlvciBvZiBgdmFyYCB3aGljaCBldmVyeW9uZSBoYXRlc1xuICBpZiAodXNlckFnZW50KSB7XG4gICAgdmFyIGFnZW50ID0gdXNlckFnZW50WzFdO1xuICAgIHZhciB2ZXJzaW9uID0gcGFyc2VJbnQodXNlckFnZW50WzJdKTtcbiAgfVxuXG4gIGlmIChcbiAgICBuYXRpdmVBZGRBbGwgJiYgKCF1c2VyQWdlbnQgfHxcbiAgICAgIChhZ2VudCA9PT0gJ0ZpcmVmb3gnICYmIHZlcnNpb24gPj0gNDYpIHx8XG4gICAgICAoYWdlbnQgPT09ICdDaHJvbWUnICAmJiB2ZXJzaW9uID49IDUwKVxuICAgIClcbiAgKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgQ2FjaGUucHJvdG90eXBlLmFkZEFsbCA9IGZ1bmN0aW9uIGFkZEFsbChyZXF1ZXN0cykge1xuICAgIHZhciBjYWNoZSA9IHRoaXM7XG5cbiAgICAvLyBTaW5jZSBET01FeGNlcHRpb25zIGFyZSBub3QgY29uc3RydWN0YWJsZTpcbiAgICBmdW5jdGlvbiBOZXR3b3JrRXJyb3IobWVzc2FnZSkge1xuICAgICAgdGhpcy5uYW1lID0gJ05ldHdvcmtFcnJvcic7XG4gICAgICB0aGlzLmNvZGUgPSAxOTtcbiAgICAgIHRoaXMubWVzc2FnZSA9IG1lc3NhZ2U7XG4gICAgfVxuXG4gICAgTmV0d29ya0Vycm9yLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoRXJyb3IucHJvdG90eXBlKTtcblxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPCAxKSB0aHJvdyBuZXcgVHlwZUVycm9yKCk7XG5cbiAgICAgIC8vIFNpbXVsYXRlIHNlcXVlbmNlPChSZXF1ZXN0IG9yIFVTVlN0cmluZyk+IGJpbmRpbmc6XG4gICAgICB2YXIgc2VxdWVuY2UgPSBbXTtcblxuICAgICAgcmVxdWVzdHMgPSByZXF1ZXN0cy5tYXAoZnVuY3Rpb24ocmVxdWVzdCkge1xuICAgICAgICBpZiAocmVxdWVzdCBpbnN0YW5jZW9mIFJlcXVlc3QpIHtcbiAgICAgICAgICByZXR1cm4gcmVxdWVzdDtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gU3RyaW5nKHJlcXVlc3QpOyAvLyBtYXkgdGhyb3cgVHlwZUVycm9yXG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgIHJlcXVlc3RzLm1hcChmdW5jdGlvbihyZXF1ZXN0KSB7XG4gICAgICAgICAgaWYgKHR5cGVvZiByZXF1ZXN0ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgcmVxdWVzdCA9IG5ldyBSZXF1ZXN0KHJlcXVlc3QpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHZhciBzY2hlbWUgPSBuZXcgVVJMKHJlcXVlc3QudXJsKS5wcm90b2NvbDtcblxuICAgICAgICAgIGlmIChzY2hlbWUgIT09ICdodHRwOicgJiYgc2NoZW1lICE9PSAnaHR0cHM6Jykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE5ldHdvcmtFcnJvcihcIkludmFsaWQgc2NoZW1lXCIpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHJldHVybiBmZXRjaChyZXF1ZXN0LmNsb25lKCkpO1xuICAgICAgICB9KVxuICAgICAgKTtcbiAgICB9KS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlcykge1xuICAgICAgLy8gSWYgc29tZSBvZiB0aGUgcmVzcG9uc2VzIGhhcyBub3QgT0stZWlzaCBzdGF0dXMsXG4gICAgICAvLyB0aGVuIHdob2xlIG9wZXJhdGlvbiBzaG91bGQgcmVqZWN0XG4gICAgICBpZiAocmVzcG9uc2VzLnNvbWUoZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgICAgcmV0dXJuICFyZXNwb25zZS5vaztcbiAgICAgIH0pKSB7XG4gICAgICAgIHRocm93IG5ldyBOZXR3b3JrRXJyb3IoJ0luY29ycmVjdCByZXNwb25zZSBzdGF0dXMnKTtcbiAgICAgIH1cblxuICAgICAgLy8gVE9ETzogY2hlY2sgdGhhdCByZXF1ZXN0cyBkb24ndCBvdmVyd3JpdGUgb25lIGFub3RoZXJcbiAgICAgIC8vIChkb24ndCB0aGluayB0aGlzIGlzIHBvc3NpYmxlIHRvIHBvbHlmaWxsIGR1ZSB0byBvcGFxdWUgcmVzcG9uc2VzKVxuICAgICAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgICAgICByZXNwb25zZXMubWFwKGZ1bmN0aW9uKHJlc3BvbnNlLCBpKSB7XG4gICAgICAgICAgcmV0dXJuIGNhY2hlLnB1dChyZXF1ZXN0c1tpXSwgcmVzcG9uc2UpO1xuICAgICAgICB9KVxuICAgICAgKTtcbiAgICB9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9KTtcbiAgfTtcblxuICBDYWNoZS5wcm90b3R5cGUuYWRkID0gZnVuY3Rpb24gYWRkKHJlcXVlc3QpIHtcbiAgICByZXR1cm4gdGhpcy5hZGRBbGwoW3JlcXVlc3RdKTtcbiAgfTtcbn0oKSk7Il19
