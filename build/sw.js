(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

const tplURL = '/wiki/Test';
const swt = require('sw-toolbox');

swt.precache([tplURL]);
swt.cache.name = 'wmf-test-cache';

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJsaWIvc3cuanMiLCJub2RlX21vZHVsZXMvc3ctdG9vbGJveC9saWIvaGVscGVycy5qcyIsIm5vZGVfbW9kdWxlcy9zdy10b29sYm94L2xpYi9pZGItY2FjaGUtZXhwaXJhdGlvbi5qcyIsIm5vZGVfbW9kdWxlcy9zdy10b29sYm94L2xpYi9vcHRpb25zLmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbGliL3JvdXRlLmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbGliL3JvdXRlci5qcyIsIm5vZGVfbW9kdWxlcy9zdy10b29sYm94L2xpYi9zdHJhdGVnaWVzL2NhY2hlRmlyc3QuanMiLCJub2RlX21vZHVsZXMvc3ctdG9vbGJveC9saWIvc3RyYXRlZ2llcy9jYWNoZU9ubHkuanMiLCJub2RlX21vZHVsZXMvc3ctdG9vbGJveC9saWIvc3RyYXRlZ2llcy9mYXN0ZXN0LmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbGliL3N0cmF0ZWdpZXMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvc3ctdG9vbGJveC9saWIvc3RyYXRlZ2llcy9uZXR3b3JrRmlyc3QuanMiLCJub2RlX21vZHVsZXMvc3ctdG9vbGJveC9saWIvc3RyYXRlZ2llcy9uZXR3b3JrT25seS5qcyIsIm5vZGVfbW9kdWxlcy9zdy10b29sYm94L2xpYi9zdy10b29sYm94LmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbm9kZV9tb2R1bGVzL3BhdGgtdG8tcmVnZXhwL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbm9kZV9tb2R1bGVzL3BhdGgtdG8tcmVnZXhwL25vZGVfbW9kdWxlcy9pc2FycmF5L2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3N3LXRvb2xib3gvbm9kZV9tb2R1bGVzL3NlcnZpY2V3b3JrZXItY2FjaGUtcG9seWZpbGwvaW5kZXguanMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDaEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1SUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1REE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNyREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN0QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeEJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzFhQTtBQUNBO0FBQ0E7QUFDQTs7QUNIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCIndXNlIHN0cmljdCc7XG5cbmNvbnN0IHRwbFVSTCA9ICcvd2lraS9UZXN0JztcbmNvbnN0IHN3dCA9IHJlcXVpcmUoJ3N3LXRvb2xib3gnKTtcblxuc3d0LnByZWNhY2hlKFt0cGxVUkxdKTtcbnN3dC5jYWNoZS5uYW1lID0gJ3dtZi10ZXN0LWNhY2hlJztcblxuZnVuY3Rpb24gZmV0Y2hCb2R5KHJlcSwgdGl0bGUpIHtcblx0Y29uc3QgcHJvdG9Ib3N0ID0gcmVxLnVybC5tYXRjaCgvXihodHRwcz86XFwvXFwvW15cXC9dKylcXC8vKVsxXTtcbiAgICByZXR1cm4gc3d0Lm5ldHdvcmtGaXJzdChuZXcgUmVxdWVzdChwcm90b0hvc3QgKyAnL2FwaS9yZXN0X3YxL3BhZ2UvaHRtbC8nXG4gICAgICAgICAgICAgICAgKyBlbmNvZGVVUklDb21wb25lbnQoZGVjb2RlVVJJQ29tcG9uZW50KHRpdGxlKSkpLCB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuYW1lOiAnYXBpX2h0bWwnLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWF4RW50cmllczogMTAwLFxuICAgICAgICAgICAgICAgICAgICAgICAgbWF4QWdlU2Vjb25kczogMTg2NDAwXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICB9KVxuICAgIC50aGVuKHJlcyA9PiB7XG4gICAgICAgIGlmIChyZXMuc3RhdHVzID09PSAyMDApIHtcbiAgICAgICAgICAgIHJldHVybiByZXMudGV4dCgpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIFwiPGJvZHk+RXJyb3IgZmV0Y2hpbmcgYm9keSBmb3IgXCIgKyB0aXRsZSArICc6ICdcbiAgICAgICAgICAgICAgICArIHJlcy5zdGF0dXMgKyBcIjwvYm9keT5cIjtcbiAgICAgICAgfVxuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBnZXRUZW1wbGF0ZSgpIHtcbiAgICByZXR1cm4gc3d0LmNhY2hlRmlyc3QodHBsVVJMKTtcbn1cblxuZnVuY3Rpb24gY2hlYXBCb2R5SW5uZXJIVE1MKGh0bWwpIHtcbiAgICB2YXIgbWF0Y2ggPSAvPGJvZHlbXj5dKj4oW1xcc1xcU10qKTxcXC9ib2R5Pi8uZXhlYyhodG1sKTtcbiAgICBpZiAoIW1hdGNoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignTm8gSFRNTCBib2R5IGZvdW5kIScpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBtYXRjaFsxXTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHJlcGxhY2VDb250ZW50KHRwbCwgY29udGVudCkge1xuICAgIHZhciBib2R5TWF0Y2hlciA9IC8oPGRpdiBpZD1cIm13LWNvbnRlbnQtdGV4dFwiW14+XSo+KVtcXHNcXFNdKig8ZGl2IGNsYXNzPVwicHJpbnRmb290ZXJcIikvaW07XG4gICAgcmV0dXJuIHRwbC5yZXBsYWNlKGJvZHlNYXRjaGVyLCAoYWxsLCBzdGFydCwgZW5kKSA9PiBzdGFydCArIGNvbnRlbnQgKyBlbmQpO1xufVxuXG5jb25zdCBlc2NhcGVzID0ge1xuICAgICc8JzogJyZsdDsnLFxuICAgICdcIic6ICcmcXVvdDsnLFxuICAgIFwiJ1wiOiAnJiMzOTsnXG59O1xuXG5mdW5jdGlvbiBpbmplY3RCb2R5KHRwbCwgYm9keSwgcmVxLCB0aXRsZSkge1xuICAgIC8vIEhhY2sgaGFjayBoYWNrLi5cbiAgICAvLyBJbiBhIHJlYWwgaW1wbGVtZW50YXRpb24sIHRoaXMgd2lsbFxuICAgIC8vIC0gaWRlbnRpZnkgcGFnZSBjb21wb25lbnRzIGluIGEgdGVtcGxhdGUsXG4gICAgLy8gLSBldmFsdWF0ZSBhbmQgZWFjaCBjb21wb25lbnQsIGFuZFxuICAgIC8vIC0gc3RyZWFtIGV4cGFuZGVkIHRlbXBsYXRlIHBhcnRzIC8gY29tcG9uZW50cyBhcyBzb29uIGFzIHRoZXkgYXJlXG4gICAgLy8gICBhdmFpbGFibGUuXG4gICAgdHBsID0gdHBsLnJlcGxhY2UoL1Rlc3QvZywgdGl0bGUuc3BsaXQoJy8nKS5tYXAoZGVjb2RlVVJJQ29tcG9uZW50KS5qb2luKCcvJylcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9bPFwiJ10vZywgcyA9PiBlc2NhcGVzW3NdKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnJlcGxhY2UoL18vZywgJyAnKSk7XG4gICAgLy8gQXBwZW5kIHBhcnNvaWQgYW5kIGNpdGUgY3NzIG1vZHVsZXNcbiAgICB0cGwgPSB0cGwucmVwbGFjZSgvbW9kdWxlcz0oW14mXSspJi8sICdtb2R1bGVzPSQxJTdDbWVkaWF3aWtpLnNraW5uaW5nLmNvbnRlbnQucGFyc29pZCU3Q2V4dC5jaXRlLnN0eWxlJicpO1xuICAgIC8vIHRwbCA9IHRwbC5yZXBsYWNlKC9cXC93aWtpXFwvL2csICcvdy9pa2kvJyk7XG4gICAgcmV0dXJuIHJlcGxhY2VDb250ZW50KHRwbCwgY2hlYXBCb2R5SW5uZXJIVE1MKGJvZHkpKTtcbn1cblxuZnVuY3Rpb24gYXNzZW1ibGVQYWdlKHJlcSkge1xuICAgIHZhciB0aXRsZSA9IHJlcS51cmwubWF0Y2goL1xcL3dcXC8/aWtpXFwvKFteP10rKSQvKVsxXTtcbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoW2dldFRlbXBsYXRlKCksIGZldGNoQm9keShyZXEsIHRpdGxlKV0pXG4gICAgICAgIC50aGVuKHJlc3VsdHMgPT4gaW5qZWN0Qm9keShyZXN1bHRzWzBdLCByZXN1bHRzWzFdLCByZXEsIHRpdGxlKSk7XG59XG5cbnN3dC5yb3V0ZXIuZ2V0KC9odHRwcz86XFwvXFwvW15cXC9dK1xcL3dcXC8/aWtpXFwvW14/XSskLywgKHJlcXVlc3QsIG9wdGlvbnMpID0+IGFzc2VtYmxlUGFnZShyZXF1ZXN0KVxuICAgICAgICAudGhlbihib2R5ID0+IG5ldyBSZXNwb25zZShib2R5LCB7XG4gICAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICAgICAgJ2NvbnRlbnQtdHlwZSc6ICd0ZXh0L2h0bWw7Y2hhcnNldD11dGYtOCdcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkpKTtcbiIsIi8qXG4gIENvcHlyaWdodCAyMDE0IEdvb2dsZSBJbmMuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuXG5cbiAgTGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcbiAgeW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuICBZb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXRcblxuICAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG5cbiAgVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuICBkaXN0cmlidXRlZCB1bmRlciB0aGUgTGljZW5zZSBpcyBkaXN0cmlidXRlZCBvbiBhbiBcIkFTIElTXCIgQkFTSVMsXG4gIFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuICBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gIGxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLlxuKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIGdsb2JhbE9wdGlvbnMgPSByZXF1aXJlKCcuL29wdGlvbnMnKTtcbnZhciBpZGJDYWNoZUV4cGlyYXRpb24gPSByZXF1aXJlKCcuL2lkYi1jYWNoZS1leHBpcmF0aW9uJyk7XG5cbmZ1bmN0aW9uIGRlYnVnKG1lc3NhZ2UsIG9wdGlvbnMpIHtcbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gIHZhciBmbGFnID0gb3B0aW9ucy5kZWJ1ZyB8fCBnbG9iYWxPcHRpb25zLmRlYnVnO1xuICBpZiAoZmxhZykge1xuICAgIGNvbnNvbGUubG9nKCdbc3ctdG9vbGJveF0gJyArIG1lc3NhZ2UpO1xuICB9XG59XG5cbmZ1bmN0aW9uIG9wZW5DYWNoZShvcHRpb25zKSB7XG4gIHZhciBjYWNoZU5hbWU7XG4gIGlmIChvcHRpb25zICYmIG9wdGlvbnMuY2FjaGUpIHtcbiAgICBjYWNoZU5hbWUgPSBvcHRpb25zLmNhY2hlLm5hbWU7XG4gIH1cbiAgY2FjaGVOYW1lID0gY2FjaGVOYW1lIHx8IGdsb2JhbE9wdGlvbnMuY2FjaGUubmFtZTtcblxuICByZXR1cm4gY2FjaGVzLm9wZW4oY2FjaGVOYW1lKTtcbn1cblxuZnVuY3Rpb24gZmV0Y2hBbmRDYWNoZShyZXF1ZXN0LCBvcHRpb25zKSB7XG4gIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICB2YXIgc3VjY2Vzc1Jlc3BvbnNlcyA9IG9wdGlvbnMuc3VjY2Vzc1Jlc3BvbnNlcyB8fFxuICAgICAgZ2xvYmFsT3B0aW9ucy5zdWNjZXNzUmVzcG9uc2VzO1xuXG4gIHJldHVybiBmZXRjaChyZXF1ZXN0LmNsb25lKCkpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAvLyBPbmx5IGNhY2hlIEdFVCByZXF1ZXN0cyB3aXRoIHN1Y2Nlc3NmdWwgcmVzcG9uc2VzLlxuICAgIC8vIFNpbmNlIHRoaXMgaXMgbm90IHBhcnQgb2YgdGhlIHByb21pc2UgY2hhaW4sIGl0IHdpbGwgYmUgZG9uZVxuICAgIC8vIGFzeW5jaHJvbm91c2x5IGFuZCB3aWxsIG5vdCBibG9jayB0aGUgcmVzcG9uc2UgZnJvbSBiZWluZyByZXR1cm5lZCB0byB0aGVcbiAgICAvLyBwYWdlLlxuICAgIGlmIChyZXF1ZXN0Lm1ldGhvZCA9PT0gJ0dFVCcgJiYgc3VjY2Vzc1Jlc3BvbnNlcy50ZXN0KHJlc3BvbnNlLnN0YXR1cykpIHtcbiAgICAgIG9wZW5DYWNoZShvcHRpb25zKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgICAgIGNhY2hlLnB1dChyZXF1ZXN0LCByZXNwb25zZSkudGhlbihmdW5jdGlvbigpIHtcbiAgICAgICAgICAvLyBJZiBhbnkgb2YgdGhlIG9wdGlvbnMgYXJlIHByb3ZpZGVkIGluIG9wdGlvbnMuY2FjaGUgdGhlbiB1c2UgdGhlbS5cbiAgICAgICAgICAvLyBEbyBub3QgZmFsbGJhY2sgdG8gdGhlIGdsb2JhbCBvcHRpb25zIGZvciBhbnkgdGhhdCBhcmUgbWlzc2luZ1xuICAgICAgICAgIC8vIHVubGVzcyB0aGV5IGFyZSBhbGwgbWlzc2luZy5cbiAgICAgICAgICB2YXIgY2FjaGVPcHRpb25zID0gb3B0aW9ucy5jYWNoZSB8fCBnbG9iYWxPcHRpb25zLmNhY2hlO1xuXG4gICAgICAgICAgLy8gT25seSBydW4gdGhlIGNhY2hlIGV4cGlyYXRpb24gbG9naWMgaWYgYXQgbGVhc3Qgb25lIG9mIHRoZSBtYXhpbXVtc1xuICAgICAgICAgIC8vIGlzIHNldCwgYW5kIGlmIHdlIGhhdmUgYSBuYW1lIGZvciB0aGUgY2FjaGUgdGhhdCB0aGUgb3B0aW9ucyBhcmVcbiAgICAgICAgICAvLyBiZWluZyBhcHBsaWVkIHRvLlxuICAgICAgICAgIGlmICgoY2FjaGVPcHRpb25zLm1heEVudHJpZXMgfHwgY2FjaGVPcHRpb25zLm1heEFnZVNlY29uZHMpICYmXG4gICAgICAgICAgICAgIGNhY2hlT3B0aW9ucy5uYW1lKSB7XG4gICAgICAgICAgICBxdWV1ZUNhY2hlRXhwaXJhdGlvbihyZXF1ZXN0LCBjYWNoZSwgY2FjaGVPcHRpb25zKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3BvbnNlLmNsb25lKCk7XG4gIH0pO1xufVxuXG52YXIgY2xlYW51cFF1ZXVlO1xuZnVuY3Rpb24gcXVldWVDYWNoZUV4cGlyYXRpb24ocmVxdWVzdCwgY2FjaGUsIGNhY2hlT3B0aW9ucykge1xuICB2YXIgY2xlYW51cCA9IGNsZWFudXBDYWNoZS5iaW5kKG51bGwsIHJlcXVlc3QsIGNhY2hlLCBjYWNoZU9wdGlvbnMpO1xuXG4gIGlmIChjbGVhbnVwUXVldWUpIHtcbiAgICBjbGVhbnVwUXVldWUgPSBjbGVhbnVwUXVldWUudGhlbihjbGVhbnVwKTtcbiAgfSBlbHNlIHtcbiAgICBjbGVhbnVwUXVldWUgPSBjbGVhbnVwKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2xlYW51cENhY2hlKHJlcXVlc3QsIGNhY2hlLCBjYWNoZU9wdGlvbnMpIHtcbiAgdmFyIHJlcXVlc3RVcmwgPSByZXF1ZXN0LnVybDtcbiAgdmFyIG1heEFnZVNlY29uZHMgPSBjYWNoZU9wdGlvbnMubWF4QWdlU2Vjb25kcztcbiAgdmFyIG1heEVudHJpZXMgPSBjYWNoZU9wdGlvbnMubWF4RW50cmllcztcbiAgdmFyIGNhY2hlTmFtZSA9IGNhY2hlT3B0aW9ucy5uYW1lO1xuXG4gIHZhciBub3cgPSBEYXRlLm5vdygpO1xuICBkZWJ1ZygnVXBkYXRpbmcgTFJVIG9yZGVyIGZvciAnICsgcmVxdWVzdFVybCArICcuIE1heCBlbnRyaWVzIGlzICcgK1xuICAgIG1heEVudHJpZXMgKyAnLCBtYXggYWdlIGlzICcgKyBtYXhBZ2VTZWNvbmRzKTtcblxuICByZXR1cm4gaWRiQ2FjaGVFeHBpcmF0aW9uLmdldERiKGNhY2hlTmFtZSkudGhlbihmdW5jdGlvbihkYikge1xuICAgIHJldHVybiBpZGJDYWNoZUV4cGlyYXRpb24uc2V0VGltZXN0YW1wRm9yVXJsKGRiLCByZXF1ZXN0VXJsLCBub3cpO1xuICB9KS50aGVuKGZ1bmN0aW9uKGRiKSB7XG4gICAgcmV0dXJuIGlkYkNhY2hlRXhwaXJhdGlvbi5leHBpcmVFbnRyaWVzKGRiLCBtYXhFbnRyaWVzLCBtYXhBZ2VTZWNvbmRzLCBub3cpO1xuICB9KS50aGVuKGZ1bmN0aW9uKHVybHNUb0RlbGV0ZSkge1xuICAgIGRlYnVnKCdTdWNjZXNzZnVsbHkgdXBkYXRlZCBJREIuJyk7XG5cbiAgICB2YXIgZGVsZXRpb25Qcm9taXNlcyA9IHVybHNUb0RlbGV0ZS5tYXAoZnVuY3Rpb24odXJsVG9EZWxldGUpIHtcbiAgICAgIHJldHVybiBjYWNoZS5kZWxldGUodXJsVG9EZWxldGUpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKGRlbGV0aW9uUHJvbWlzZXMpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICBkZWJ1ZygnRG9uZSB3aXRoIGNhY2hlIGNsZWFudXAuJyk7XG4gICAgfSk7XG4gIH0pLmNhdGNoKGZ1bmN0aW9uKGVycm9yKSB7XG4gICAgZGVidWcoZXJyb3IpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuYW1lQ2FjaGUoc291cmNlLCBkZXN0aW5hdGlvbiwgb3B0aW9ucykge1xuICBkZWJ1ZygnUmVuYW1pbmcgY2FjaGU6IFsnICsgc291cmNlICsgJ10gdG8gWycgKyBkZXN0aW5hdGlvbiArICddJywgb3B0aW9ucyk7XG4gIHJldHVybiBjYWNoZXMuZGVsZXRlKGRlc3RpbmF0aW9uKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBQcm9taXNlLmFsbChbXG4gICAgICBjYWNoZXMub3Blbihzb3VyY2UpLFxuICAgICAgY2FjaGVzLm9wZW4oZGVzdGluYXRpb24pXG4gICAgXSkudGhlbihmdW5jdGlvbihyZXN1bHRzKSB7XG4gICAgICB2YXIgc291cmNlQ2FjaGUgPSByZXN1bHRzWzBdO1xuICAgICAgdmFyIGRlc3RDYWNoZSA9IHJlc3VsdHNbMV07XG5cbiAgICAgIHJldHVybiBzb3VyY2VDYWNoZS5rZXlzKCkudGhlbihmdW5jdGlvbihyZXF1ZXN0cykge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwocmVxdWVzdHMubWFwKGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgICAgICAgICByZXR1cm4gc291cmNlQ2FjaGUubWF0Y2gocmVxdWVzdCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgICAgICAgcmV0dXJuIGRlc3RDYWNoZS5wdXQocmVxdWVzdCwgcmVzcG9uc2UpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KSk7XG4gICAgICB9KS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICByZXR1cm4gY2FjaGVzLmRlbGV0ZShzb3VyY2UpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgZGVidWc6IGRlYnVnLFxuICBmZXRjaEFuZENhY2hlOiBmZXRjaEFuZENhY2hlLFxuICBvcGVuQ2FjaGU6IG9wZW5DYWNoZSxcbiAgcmVuYW1lQ2FjaGU6IHJlbmFtZUNhY2hlXG59O1xuIiwiLypcbiBDb3B5cmlnaHQgMjAxNSBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG4gTGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcbiB5b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG4gWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG5cbiBVbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG4gZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuIFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuIFNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcbiBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBEQl9QUkVGSVggPSAnc3ctdG9vbGJveC0nO1xudmFyIERCX1ZFUlNJT04gPSAxO1xudmFyIFNUT1JFX05BTUUgPSAnc3RvcmUnO1xudmFyIFVSTF9QUk9QRVJUWSA9ICd1cmwnO1xudmFyIFRJTUVTVEFNUF9QUk9QRVJUWSA9ICd0aW1lc3RhbXAnO1xudmFyIGNhY2hlTmFtZVRvRGJQcm9taXNlID0ge307XG5cbmZ1bmN0aW9uIG9wZW5EYihjYWNoZU5hbWUpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHZhciByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4oREJfUFJFRklYICsgY2FjaGVOYW1lLCBEQl9WRVJTSU9OKTtcblxuICAgIHJlcXVlc3Qub251cGdyYWRlbmVlZGVkID0gZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgb2JqZWN0U3RvcmUgPSByZXF1ZXN0LnJlc3VsdC5jcmVhdGVPYmplY3RTdG9yZShTVE9SRV9OQU1FLFxuICAgICAgICAgIHtrZXlQYXRoOiBVUkxfUFJPUEVSVFl9KTtcbiAgICAgIG9iamVjdFN0b3JlLmNyZWF0ZUluZGV4KFRJTUVTVEFNUF9QUk9QRVJUWSwgVElNRVNUQU1QX1BST1BFUlRZLFxuICAgICAgICAgIHt1bmlxdWU6IGZhbHNlfSk7XG4gICAgfTtcblxuICAgIHJlcXVlc3Qub25zdWNjZXNzID0gZnVuY3Rpb24oKSB7XG4gICAgICByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcbiAgICB9O1xuXG4gICAgcmVxdWVzdC5vbmVycm9yID0gZnVuY3Rpb24oKSB7XG4gICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgfTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGdldERiKGNhY2hlTmFtZSkge1xuICBpZiAoIShjYWNoZU5hbWUgaW4gY2FjaGVOYW1lVG9EYlByb21pc2UpKSB7XG4gICAgY2FjaGVOYW1lVG9EYlByb21pc2VbY2FjaGVOYW1lXSA9IG9wZW5EYihjYWNoZU5hbWUpO1xuICB9XG5cbiAgcmV0dXJuIGNhY2hlTmFtZVRvRGJQcm9taXNlW2NhY2hlTmFtZV07XG59XG5cbmZ1bmN0aW9uIHNldFRpbWVzdGFtcEZvclVybChkYiwgdXJsLCBub3cpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCkge1xuICAgIHZhciB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKFNUT1JFX05BTUUsICdyZWFkd3JpdGUnKTtcbiAgICB2YXIgb2JqZWN0U3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShTVE9SRV9OQU1FKTtcbiAgICBvYmplY3RTdG9yZS5wdXQoe3VybDogdXJsLCB0aW1lc3RhbXA6IG5vd30pO1xuXG4gICAgdHJhbnNhY3Rpb24ub25jb21wbGV0ZSA9IGZ1bmN0aW9uKCkge1xuICAgICAgcmVzb2x2ZShkYik7XG4gICAgfTtcblxuICAgIHRyYW5zYWN0aW9uLm9uYWJvcnQgPSBmdW5jdGlvbigpIHtcbiAgICAgIHJlamVjdCh0cmFuc2FjdGlvbi5lcnJvcik7XG4gICAgfTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGV4cGlyZU9sZEVudHJpZXMoZGIsIG1heEFnZVNlY29uZHMsIG5vdykge1xuICAvLyBCYWlsIG91dCBlYXJseSBieSByZXNvbHZpbmcgd2l0aCBhbiBlbXB0eSBhcnJheSBpZiB3ZSdyZSBub3QgdXNpbmdcbiAgLy8gbWF4QWdlU2Vjb25kcy5cbiAgaWYgKCFtYXhBZ2VTZWNvbmRzKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShbXSk7XG4gIH1cblxuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgdmFyIG1heEFnZU1pbGxpcyA9IG1heEFnZVNlY29uZHMgKiAxMDAwO1xuICAgIHZhciB1cmxzID0gW107XG5cbiAgICB2YXIgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihTVE9SRV9OQU1FLCAncmVhZHdyaXRlJyk7XG4gICAgdmFyIG9iamVjdFN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoU1RPUkVfTkFNRSk7XG4gICAgdmFyIGluZGV4ID0gb2JqZWN0U3RvcmUuaW5kZXgoVElNRVNUQU1QX1BST1BFUlRZKTtcblxuICAgIGluZGV4Lm9wZW5DdXJzb3IoKS5vbnN1Y2Nlc3MgPSBmdW5jdGlvbihjdXJzb3JFdmVudCkge1xuICAgICAgdmFyIGN1cnNvciA9IGN1cnNvckV2ZW50LnRhcmdldC5yZXN1bHQ7XG4gICAgICBpZiAoY3Vyc29yKSB7XG4gICAgICAgIGlmIChub3cgLSBtYXhBZ2VNaWxsaXMgPiBjdXJzb3IudmFsdWVbVElNRVNUQU1QX1BST1BFUlRZXSkge1xuICAgICAgICAgIHZhciB1cmwgPSBjdXJzb3IudmFsdWVbVVJMX1BST1BFUlRZXTtcbiAgICAgICAgICB1cmxzLnB1c2godXJsKTtcbiAgICAgICAgICBvYmplY3RTdG9yZS5kZWxldGUodXJsKTtcbiAgICAgICAgICBjdXJzb3IuY29udGludWUoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG5cbiAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gZnVuY3Rpb24oKSB7XG4gICAgICByZXNvbHZlKHVybHMpO1xuICAgIH07XG5cbiAgICB0cmFuc2FjdGlvbi5vbmFib3J0ID0gcmVqZWN0O1xuICB9KTtcbn1cblxuZnVuY3Rpb24gZXhwaXJlRXh0cmFFbnRyaWVzKGRiLCBtYXhFbnRyaWVzKSB7XG4gIC8vIEJhaWwgb3V0IGVhcmx5IGJ5IHJlc29sdmluZyB3aXRoIGFuIGVtcHR5IGFycmF5IGlmIHdlJ3JlIG5vdCB1c2luZ1xuICAvLyBtYXhFbnRyaWVzLlxuICBpZiAoIW1heEVudHJpZXMpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFtdKTtcbiAgfVxuXG4gIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICB2YXIgdXJscyA9IFtdO1xuXG4gICAgdmFyIHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oU1RPUkVfTkFNRSwgJ3JlYWR3cml0ZScpO1xuICAgIHZhciBvYmplY3RTdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKFNUT1JFX05BTUUpO1xuICAgIHZhciBpbmRleCA9IG9iamVjdFN0b3JlLmluZGV4KFRJTUVTVEFNUF9QUk9QRVJUWSk7XG5cbiAgICB2YXIgY291bnRSZXF1ZXN0ID0gaW5kZXguY291bnQoKTtcbiAgICBpbmRleC5jb3VudCgpLm9uc3VjY2VzcyA9IGZ1bmN0aW9uKCkge1xuICAgICAgdmFyIGluaXRpYWxDb3VudCA9IGNvdW50UmVxdWVzdC5yZXN1bHQ7XG5cbiAgICAgIGlmIChpbml0aWFsQ291bnQgPiBtYXhFbnRyaWVzKSB7XG4gICAgICAgIGluZGV4Lm9wZW5DdXJzb3IoKS5vbnN1Y2Nlc3MgPSBmdW5jdGlvbihjdXJzb3JFdmVudCkge1xuICAgICAgICAgIHZhciBjdXJzb3IgPSBjdXJzb3JFdmVudC50YXJnZXQucmVzdWx0O1xuICAgICAgICAgIGlmIChjdXJzb3IpIHtcbiAgICAgICAgICAgIHZhciB1cmwgPSBjdXJzb3IudmFsdWVbVVJMX1BST1BFUlRZXTtcbiAgICAgICAgICAgIHVybHMucHVzaCh1cmwpO1xuICAgICAgICAgICAgb2JqZWN0U3RvcmUuZGVsZXRlKHVybCk7XG4gICAgICAgICAgICBpZiAoaW5pdGlhbENvdW50IC0gdXJscy5sZW5ndGggPiBtYXhFbnRyaWVzKSB7XG4gICAgICAgICAgICAgIGN1cnNvci5jb250aW51ZSgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgdHJhbnNhY3Rpb24ub25jb21wbGV0ZSA9IGZ1bmN0aW9uKCkge1xuICAgICAgcmVzb2x2ZSh1cmxzKTtcbiAgICB9O1xuXG4gICAgdHJhbnNhY3Rpb24ub25hYm9ydCA9IHJlamVjdDtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGV4cGlyZUVudHJpZXMoZGIsIG1heEVudHJpZXMsIG1heEFnZVNlY29uZHMsIG5vdykge1xuICByZXR1cm4gZXhwaXJlT2xkRW50cmllcyhkYiwgbWF4QWdlU2Vjb25kcywgbm93KS50aGVuKGZ1bmN0aW9uKG9sZFVybHMpIHtcbiAgICByZXR1cm4gZXhwaXJlRXh0cmFFbnRyaWVzKGRiLCBtYXhFbnRyaWVzKS50aGVuKGZ1bmN0aW9uKGV4dHJhVXJscykge1xuICAgICAgcmV0dXJuIG9sZFVybHMuY29uY2F0KGV4dHJhVXJscyk7XG4gICAgfSk7XG4gIH0pO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgZ2V0RGI6IGdldERiLFxuICBzZXRUaW1lc3RhbXBGb3JVcmw6IHNldFRpbWVzdGFtcEZvclVybCxcbiAgZXhwaXJlRW50cmllczogZXhwaXJlRW50cmllc1xufTtcbiIsIi8qXG5cdENvcHlyaWdodCAyMDE1IEdvb2dsZSBJbmMuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuXG5cblx0TGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcblx0eW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuXHRZb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXRcblxuICAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG5cblx0VW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuXHRkaXN0cmlidXRlZCB1bmRlciB0aGUgTGljZW5zZSBpcyBkaXN0cmlidXRlZCBvbiBhbiBcIkFTIElTXCIgQkFTSVMsXG5cdFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuXHRTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG5cdGxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLlxuKi9cbid1c2Ugc3RyaWN0JztcblxuLy8gVE9ETzogVGhpcyBpcyBuZWNlc3NhcnkgdG8gaGFuZGxlIGRpZmZlcmVudCBpbXBsZW1lbnRhdGlvbnMgaW4gdGhlIHdpbGRcbi8vIFRoZSBzcGVjIGRlZmluZXMgc2VsZi5yZWdpc3RyYXRpb24sIGJ1dCBpdCB3YXMgbm90IGltcGxlbWVudGVkIGluIENocm9tZSA0MC5cbnZhciBzY29wZTtcbmlmIChzZWxmLnJlZ2lzdHJhdGlvbikge1xuICBzY29wZSA9IHNlbGYucmVnaXN0cmF0aW9uLnNjb3BlO1xufSBlbHNlIHtcbiAgc2NvcGUgPSBzZWxmLnNjb3BlIHx8IG5ldyBVUkwoJy4vJywgc2VsZi5sb2NhdGlvbikuaHJlZjtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIGNhY2hlOiB7XG4gICAgbmFtZTogJyQkJHRvb2xib3gtY2FjaGUkJCQnICsgc2NvcGUgKyAnJCQkJyxcbiAgICBtYXhBZ2VTZWNvbmRzOiBudWxsLFxuICAgIG1heEVudHJpZXM6IG51bGxcbiAgfSxcbiAgZGVidWc6IGZhbHNlLFxuICBuZXR3b3JrVGltZW91dFNlY29uZHM6IG51bGwsXG4gIHByZUNhY2hlSXRlbXM6IFtdLFxuICAvLyBBIHJlZ3VsYXIgZXhwcmVzc2lvbiB0byBhcHBseSB0byBIVFRQIHJlc3BvbnNlIGNvZGVzLiBDb2RlcyB0aGF0IG1hdGNoXG4gIC8vIHdpbGwgYmUgY29uc2lkZXJlZCBzdWNjZXNzZXMsIHdoaWxlIG90aGVycyB3aWxsIG5vdCwgYW5kIHdpbGwgbm90IGJlXG4gIC8vIGNhY2hlZC5cbiAgc3VjY2Vzc1Jlc3BvbnNlczogL14wfChbMTIzXVxcZFxcZCl8KDQwWzE0NTY3XSl8NDEwJC9cbn07XG4iLCIvKlxuICBDb3B5cmlnaHQgMjAxNCBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG4gIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG4gIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cbiAgWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG4gIFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcbiAgZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICBXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cbiAgU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuICBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG4ndXNlIHN0cmljdCc7XG5cbi8vIFRPRE86IFVzZSBzZWxmLnJlZ2lzdHJhdGlvbi5zY29wZSBpbnN0ZWFkIG9mIHNlbGYubG9jYXRpb25cbnZhciB1cmwgPSBuZXcgVVJMKCcuLycsIHNlbGYubG9jYXRpb24pO1xudmFyIGJhc2VQYXRoID0gdXJsLnBhdGhuYW1lO1xudmFyIHBhdGhSZWdleHAgPSByZXF1aXJlKCdwYXRoLXRvLXJlZ2V4cCcpO1xuXG52YXIgUm91dGUgPSBmdW5jdGlvbihtZXRob2QsIHBhdGgsIGhhbmRsZXIsIG9wdGlvbnMpIHtcbiAgaWYgKHBhdGggaW5zdGFuY2VvZiBSZWdFeHApIHtcbiAgICB0aGlzLmZ1bGxVcmxSZWdFeHAgPSBwYXRoO1xuICB9IGVsc2Uge1xuICAgIC8vIFRoZSBVUkwoKSBjb25zdHJ1Y3RvciBjYW4ndCBwYXJzZSBleHByZXNzLXN0eWxlIHJvdXRlcyBhcyB0aGV5IGFyZSBub3RcbiAgICAvLyB2YWxpZCB1cmxzLiBUaGlzIG1lYW5zIHdlIGhhdmUgdG8gbWFudWFsbHkgbWFuaXB1bGF0ZSByZWxhdGl2ZSB1cmxzIGludG9cbiAgICAvLyBhYnNvbHV0ZSBvbmVzLiBUaGlzIGNoZWNrIGlzIGV4dHJlbWVseSBuYWl2ZSBidXQgaW1wbGVtZW50aW5nIGEgdHdlYWtlZFxuICAgIC8vIHZlcnNpb24gb2YgdGhlIGZ1bGwgYWxnb3JpdGhtIHNlZW1zIGxpa2Ugb3ZlcmtpbGxcbiAgICAvLyAoaHR0cHM6Ly91cmwuc3BlYy53aGF0d2cub3JnLyNjb25jZXB0LWJhc2ljLXVybC1wYXJzZXIpXG4gICAgaWYgKHBhdGguaW5kZXhPZignLycpICE9PSAwKSB7XG4gICAgICBwYXRoID0gYmFzZVBhdGggKyBwYXRoO1xuICAgIH1cblxuICAgIHRoaXMua2V5cyA9IFtdO1xuICAgIHRoaXMucmVnZXhwID0gcGF0aFJlZ2V4cChwYXRoLCB0aGlzLmtleXMpO1xuICB9XG5cbiAgdGhpcy5tZXRob2QgPSBtZXRob2Q7XG4gIHRoaXMub3B0aW9ucyA9IG9wdGlvbnM7XG4gIHRoaXMuaGFuZGxlciA9IGhhbmRsZXI7XG59O1xuXG5Sb3V0ZS5wcm90b3R5cGUubWFrZUhhbmRsZXIgPSBmdW5jdGlvbih1cmwpIHtcbiAgdmFyIHZhbHVlcztcbiAgaWYgKHRoaXMucmVnZXhwKSB7XG4gICAgdmFyIG1hdGNoID0gdGhpcy5yZWdleHAuZXhlYyh1cmwpO1xuICAgIHZhbHVlcyA9IHt9O1xuICAgIHRoaXMua2V5cy5mb3JFYWNoKGZ1bmN0aW9uKGtleSwgaW5kZXgpIHtcbiAgICAgIHZhbHVlc1trZXkubmFtZV0gPSBtYXRjaFtpbmRleCArIDFdO1xuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVyKHJlcXVlc3QsIHZhbHVlcywgdGhpcy5vcHRpb25zKTtcbiAgfS5iaW5kKHRoaXMpO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBSb3V0ZTtcbiIsIi8qXG4gIENvcHlyaWdodCAyMDE0IEdvb2dsZSBJbmMuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuXG5cbiAgTGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcbiAgeW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuICBZb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXRcblxuICAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG5cbiAgVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuICBkaXN0cmlidXRlZCB1bmRlciB0aGUgTGljZW5zZSBpcyBkaXN0cmlidXRlZCBvbiBhbiBcIkFTIElTXCIgQkFTSVMsXG4gIFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuICBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gIGxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLlxuKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIFJvdXRlID0gcmVxdWlyZSgnLi9yb3V0ZScpO1xuXG5mdW5jdGlvbiByZWdleEVzY2FwZShzKSB7XG4gIHJldHVybiBzLnJlcGxhY2UoL1stXFwvXFxcXF4kKis/LigpfFtcXF17fV0vZywgJ1xcXFwkJicpO1xufVxuXG52YXIga2V5TWF0Y2ggPSBmdW5jdGlvbihtYXAsIHN0cmluZykge1xuICAvLyBUaGlzIHdvdWxkIGJlIGJldHRlciB3cml0dGVuIGFzIGEgZm9yLi5vZiBsb29wLCBidXQgdGhhdCB3b3VsZCBicmVhayB0aGVcbiAgLy8gbWluaWZ5aWZ5IHByb2Nlc3MgaW4gdGhlIGJ1aWxkLlxuICB2YXIgZW50cmllc0l0ZXJhdG9yID0gbWFwLmVudHJpZXMoKTtcbiAgdmFyIGl0ZW0gPSBlbnRyaWVzSXRlcmF0b3IubmV4dCgpO1xuICB2YXIgbWF0Y2hlcyA9IFtdO1xuICB3aGlsZSAoIWl0ZW0uZG9uZSkge1xuICAgIHZhciBwYXR0ZXJuID0gbmV3IFJlZ0V4cChpdGVtLnZhbHVlWzBdKTtcbiAgICBpZiAocGF0dGVybi50ZXN0KHN0cmluZykpIHtcbiAgICAgIG1hdGNoZXMucHVzaChpdGVtLnZhbHVlWzFdKTtcbiAgICB9XG4gICAgaXRlbSA9IGVudHJpZXNJdGVyYXRvci5uZXh0KCk7XG4gIH1cbiAgcmV0dXJuIG1hdGNoZXM7XG59O1xuXG52YXIgUm91dGVyID0gZnVuY3Rpb24oKSB7XG4gIHRoaXMucm91dGVzID0gbmV3IE1hcCgpO1xuICAvLyBDcmVhdGUgdGhlIGR1bW15IG9yaWdpbiBmb3IgUmVnRXhwLWJhc2VkIHJvdXRlc1xuICB0aGlzLnJvdXRlcy5zZXQoUmVnRXhwLCBuZXcgTWFwKCkpO1xuICB0aGlzLmRlZmF1bHQgPSBudWxsO1xufTtcblxuWydnZXQnLCAncG9zdCcsICdwdXQnLCAnZGVsZXRlJywgJ2hlYWQnLCAnYW55J10uZm9yRWFjaChmdW5jdGlvbihtZXRob2QpIHtcbiAgUm91dGVyLnByb3RvdHlwZVttZXRob2RdID0gZnVuY3Rpb24ocGF0aCwgaGFuZGxlciwgb3B0aW9ucykge1xuICAgIHJldHVybiB0aGlzLmFkZChtZXRob2QsIHBhdGgsIGhhbmRsZXIsIG9wdGlvbnMpO1xuICB9O1xufSk7XG5cblJvdXRlci5wcm90b3R5cGUuYWRkID0gZnVuY3Rpb24obWV0aG9kLCBwYXRoLCBoYW5kbGVyLCBvcHRpb25zKSB7XG4gIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICB2YXIgb3JpZ2luO1xuXG4gIGlmIChwYXRoIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgLy8gV2UgbmVlZCBhIHVuaXF1ZSBrZXkgdG8gdXNlIGluIHRoZSBNYXAgdG8gZGlzdGluZ3Vpc2ggUmVnRXhwIHBhdGhzXG4gICAgLy8gZnJvbSBFeHByZXNzLXN0eWxlIHBhdGhzICsgb3JpZ2lucy4gU2luY2Ugd2UgY2FuIHVzZSBhbnkgb2JqZWN0IGFzIHRoZVxuICAgIC8vIGtleSBpbiBhIE1hcCwgbGV0J3MgdXNlIHRoZSBSZWdFeHAgY29uc3RydWN0b3IhXG4gICAgb3JpZ2luID0gUmVnRXhwO1xuICB9IGVsc2Uge1xuICAgIG9yaWdpbiA9IG9wdGlvbnMub3JpZ2luIHx8IHNlbGYubG9jYXRpb24ub3JpZ2luO1xuICAgIGlmIChvcmlnaW4gaW5zdGFuY2VvZiBSZWdFeHApIHtcbiAgICAgIG9yaWdpbiA9IG9yaWdpbi5zb3VyY2U7XG4gICAgfSBlbHNlIHtcbiAgICAgIG9yaWdpbiA9IHJlZ2V4RXNjYXBlKG9yaWdpbik7XG4gICAgfVxuICB9XG5cbiAgbWV0aG9kID0gbWV0aG9kLnRvTG93ZXJDYXNlKCk7XG5cbiAgdmFyIHJvdXRlID0gbmV3IFJvdXRlKG1ldGhvZCwgcGF0aCwgaGFuZGxlciwgb3B0aW9ucyk7XG5cbiAgaWYgKCF0aGlzLnJvdXRlcy5oYXMob3JpZ2luKSkge1xuICAgIHRoaXMucm91dGVzLnNldChvcmlnaW4sIG5ldyBNYXAoKSk7XG4gIH1cblxuICB2YXIgbWV0aG9kTWFwID0gdGhpcy5yb3V0ZXMuZ2V0KG9yaWdpbik7XG4gIGlmICghbWV0aG9kTWFwLmhhcyhtZXRob2QpKSB7XG4gICAgbWV0aG9kTWFwLnNldChtZXRob2QsIG5ldyBNYXAoKSk7XG4gIH1cblxuICB2YXIgcm91dGVNYXAgPSBtZXRob2RNYXAuZ2V0KG1ldGhvZCk7XG4gIHZhciByZWdFeHAgPSByb3V0ZS5yZWdleHAgfHwgcm91dGUuZnVsbFVybFJlZ0V4cDtcbiAgcm91dGVNYXAuc2V0KHJlZ0V4cC5zb3VyY2UsIHJvdXRlKTtcbn07XG5cblJvdXRlci5wcm90b3R5cGUubWF0Y2hNZXRob2QgPSBmdW5jdGlvbihtZXRob2QsIHVybCkge1xuICB2YXIgdXJsT2JqZWN0ID0gbmV3IFVSTCh1cmwpO1xuICB2YXIgb3JpZ2luID0gdXJsT2JqZWN0Lm9yaWdpbjtcbiAgdmFyIHBhdGggPSB1cmxPYmplY3QucGF0aG5hbWU7XG5cbiAgLy8gV2Ugd2FudCB0byBmaXJzdCBjaGVjayB0byBzZWUgaWYgdGhlcmUncyBhIG1hdGNoIGFnYWluc3QgYW55XG4gIC8vIFwiRXhwcmVzcy1zdHlsZVwiIHJvdXRlcyAoc3RyaW5nIGZvciB0aGUgcGF0aCwgUmVnRXhwIGZvciB0aGUgb3JpZ2luKS5cbiAgLy8gQ2hlY2tpbmcgZm9yIEV4cHJlc3Mtc3R5bGUgbWF0Y2hlcyBmaXJzdCBtYWludGFpbnMgdGhlIGxlZ2FjeSBiZWhhdmlvci5cbiAgLy8gSWYgdGhlcmUncyBubyBtYXRjaCwgd2UgbmV4dCBjaGVjayBmb3IgYSBtYXRjaCBhZ2FpbnN0IGFueSBSZWdFeHAgcm91dGVzLFxuICAvLyB3aGVyZSB0aGUgUmVnRXhwIGluIHF1ZXN0aW9uIG1hdGNoZXMgdGhlIGZ1bGwgVVJMIChib3RoIG9yaWdpbiBhbmQgcGF0aCkuXG4gIHJldHVybiB0aGlzLl9tYXRjaChtZXRob2QsIGtleU1hdGNoKHRoaXMucm91dGVzLCBvcmlnaW4pLCBwYXRoKSB8fFxuICAgIHRoaXMuX21hdGNoKG1ldGhvZCwgW3RoaXMucm91dGVzLmdldChSZWdFeHApXSwgdXJsKTtcbn07XG5cblJvdXRlci5wcm90b3R5cGUuX21hdGNoID0gZnVuY3Rpb24obWV0aG9kLCBtZXRob2RNYXBzLCBwYXRoT3JVcmwpIHtcbiAgaWYgKG1ldGhvZE1hcHMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBmb3IgKHZhciBpID0gMDsgaSA8IG1ldGhvZE1hcHMubGVuZ3RoOyBpKyspIHtcbiAgICB2YXIgbWV0aG9kTWFwID0gbWV0aG9kTWFwc1tpXTtcbiAgICB2YXIgcm91dGVNYXAgPSBtZXRob2RNYXAgJiYgbWV0aG9kTWFwLmdldChtZXRob2QudG9Mb3dlckNhc2UoKSk7XG4gICAgaWYgKHJvdXRlTWFwKSB7XG4gICAgICB2YXIgcm91dGVzID0ga2V5TWF0Y2gocm91dGVNYXAsIHBhdGhPclVybCk7XG4gICAgICBpZiAocm91dGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgcmV0dXJuIHJvdXRlc1swXS5tYWtlSGFuZGxlcihwYXRoT3JVcmwpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBudWxsO1xufTtcblxuUm91dGVyLnByb3RvdHlwZS5tYXRjaCA9IGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgcmV0dXJuIHRoaXMubWF0Y2hNZXRob2QocmVxdWVzdC5tZXRob2QsIHJlcXVlc3QudXJsKSB8fFxuICAgICAgdGhpcy5tYXRjaE1ldGhvZCgnYW55JywgcmVxdWVzdC51cmwpO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBuZXcgUm91dGVyKCk7XG4iLCIvKlxuXHRDb3B5cmlnaHQgMjAxNCBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG5cdExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG5cdHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cblx0WW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG5cdFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcblx0ZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuXHRXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cblx0U2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuXHRsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG4ndXNlIHN0cmljdCc7XG52YXIgaGVscGVycyA9IHJlcXVpcmUoJy4uL2hlbHBlcnMnKTtcblxuZnVuY3Rpb24gY2FjaGVGaXJzdChyZXF1ZXN0LCB2YWx1ZXMsIG9wdGlvbnMpIHtcbiAgaGVscGVycy5kZWJ1ZygnU3RyYXRlZ3k6IGNhY2hlIGZpcnN0IFsnICsgcmVxdWVzdC51cmwgKyAnXScsIG9wdGlvbnMpO1xuICByZXR1cm4gaGVscGVycy5vcGVuQ2FjaGUob3B0aW9ucykudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgIHJldHVybiBjYWNoZS5tYXRjaChyZXF1ZXN0KS50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICBpZiAocmVzcG9uc2UpIHtcbiAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gaGVscGVycy5mZXRjaEFuZENhY2hlKHJlcXVlc3QsIG9wdGlvbnMpO1xuICAgIH0pO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBjYWNoZUZpcnN0O1xuIiwiLypcblx0Q29weXJpZ2h0IDIwMTQgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cblxuXHRMaWNlbnNlZCB1bmRlciB0aGUgQXBhY2hlIExpY2Vuc2UsIFZlcnNpb24gMi4wICh0aGUgXCJMaWNlbnNlXCIpO1xuXHR5b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG5cdFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuXG4gICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcblxuXHRVbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG5cdGRpc3RyaWJ1dGVkIHVuZGVyIHRoZSBMaWNlbnNlIGlzIGRpc3RyaWJ1dGVkIG9uIGFuIFwiQVMgSVNcIiBCQVNJUyxcblx0V0lUSE9VVCBXQVJSQU5USUVTIE9SIENPTkRJVElPTlMgT0YgQU5ZIEtJTkQsIGVpdGhlciBleHByZXNzIG9yIGltcGxpZWQuXG5cdFNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcblx0bGltaXRhdGlvbnMgdW5kZXIgdGhlIExpY2Vuc2UuXG4qL1xuJ3VzZSBzdHJpY3QnO1xudmFyIGhlbHBlcnMgPSByZXF1aXJlKCcuLi9oZWxwZXJzJyk7XG5cbmZ1bmN0aW9uIGNhY2hlT25seShyZXF1ZXN0LCB2YWx1ZXMsIG9wdGlvbnMpIHtcbiAgaGVscGVycy5kZWJ1ZygnU3RyYXRlZ3k6IGNhY2hlIG9ubHkgWycgKyByZXF1ZXN0LnVybCArICddJywgb3B0aW9ucyk7XG4gIHJldHVybiBoZWxwZXJzLm9wZW5DYWNoZShvcHRpb25zKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgcmV0dXJuIGNhY2hlLm1hdGNoKHJlcXVlc3QpO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBjYWNoZU9ubHk7XG4iLCIvKlxuICBDb3B5cmlnaHQgMjAxNCBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG4gIExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG4gIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cbiAgWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG4gIFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcbiAgZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuICBXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cbiAgU2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuICBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG4ndXNlIHN0cmljdCc7XG52YXIgaGVscGVycyA9IHJlcXVpcmUoJy4uL2hlbHBlcnMnKTtcbnZhciBjYWNoZU9ubHkgPSByZXF1aXJlKCcuL2NhY2hlT25seScpO1xuXG5mdW5jdGlvbiBmYXN0ZXN0KHJlcXVlc3QsIHZhbHVlcywgb3B0aW9ucykge1xuICBoZWxwZXJzLmRlYnVnKCdTdHJhdGVneTogZmFzdGVzdCBbJyArIHJlcXVlc3QudXJsICsgJ10nLCBvcHRpb25zKTtcblxuICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgdmFyIHJlamVjdGVkID0gZmFsc2U7XG4gICAgdmFyIHJlYXNvbnMgPSBbXTtcblxuICAgIHZhciBtYXliZVJlamVjdCA9IGZ1bmN0aW9uKHJlYXNvbikge1xuICAgICAgcmVhc29ucy5wdXNoKHJlYXNvbi50b1N0cmluZygpKTtcbiAgICAgIGlmIChyZWplY3RlZCkge1xuICAgICAgICByZWplY3QobmV3IEVycm9yKCdCb3RoIGNhY2hlIGFuZCBuZXR3b3JrIGZhaWxlZDogXCInICtcbiAgICAgICAgICAgIHJlYXNvbnMuam9pbignXCIsIFwiJykgKyAnXCInKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWplY3RlZCA9IHRydWU7XG4gICAgICB9XG4gICAgfTtcblxuICAgIHZhciBtYXliZVJlc29sdmUgPSBmdW5jdGlvbihyZXN1bHQpIHtcbiAgICAgIGlmIChyZXN1bHQgaW5zdGFuY2VvZiBSZXNwb25zZSkge1xuICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtYXliZVJlamVjdCgnTm8gcmVzdWx0IHJldHVybmVkJyk7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGhlbHBlcnMuZmV0Y2hBbmRDYWNoZShyZXF1ZXN0LmNsb25lKCksIG9wdGlvbnMpXG4gICAgICAudGhlbihtYXliZVJlc29sdmUsIG1heWJlUmVqZWN0KTtcblxuICAgIGNhY2hlT25seShyZXF1ZXN0LCB2YWx1ZXMsIG9wdGlvbnMpXG4gICAgICAudGhlbihtYXliZVJlc29sdmUsIG1heWJlUmVqZWN0KTtcbiAgfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZmFzdGVzdDtcbiIsIi8qXG5cdENvcHlyaWdodCAyMDE0IEdvb2dsZSBJbmMuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuXG5cblx0TGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcblx0eW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuXHRZb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXRcblxuICAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG5cblx0VW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuXHRkaXN0cmlidXRlZCB1bmRlciB0aGUgTGljZW5zZSBpcyBkaXN0cmlidXRlZCBvbiBhbiBcIkFTIElTXCIgQkFTSVMsXG5cdFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuXHRTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG5cdGxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLlxuKi9cbm1vZHVsZS5leHBvcnRzID0ge1xuICBuZXR3b3JrT25seTogcmVxdWlyZSgnLi9uZXR3b3JrT25seScpLFxuICBuZXR3b3JrRmlyc3Q6IHJlcXVpcmUoJy4vbmV0d29ya0ZpcnN0JyksXG4gIGNhY2hlT25seTogcmVxdWlyZSgnLi9jYWNoZU9ubHknKSxcbiAgY2FjaGVGaXJzdDogcmVxdWlyZSgnLi9jYWNoZUZpcnN0JyksXG4gIGZhc3Rlc3Q6IHJlcXVpcmUoJy4vZmFzdGVzdCcpXG59O1xuIiwiLypcbiBDb3B5cmlnaHQgMjAxNSBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG4gTGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcbiB5b3UgbWF5IG5vdCB1c2UgdGhpcyBmaWxlIGV4Y2VwdCBpbiBjb21wbGlhbmNlIHdpdGggdGhlIExpY2Vuc2UuXG4gWW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG5cbiBVbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG4gZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuIFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuIFNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcbiBsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG4ndXNlIHN0cmljdCc7XG52YXIgZ2xvYmFsT3B0aW9ucyA9IHJlcXVpcmUoJy4uL29wdGlvbnMnKTtcbnZhciBoZWxwZXJzID0gcmVxdWlyZSgnLi4vaGVscGVycycpO1xuXG5mdW5jdGlvbiBuZXR3b3JrRmlyc3QocmVxdWVzdCwgdmFsdWVzLCBvcHRpb25zKSB7XG4gIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICB2YXIgc3VjY2Vzc1Jlc3BvbnNlcyA9IG9wdGlvbnMuc3VjY2Vzc1Jlc3BvbnNlcyB8fFxuICAgICAgZ2xvYmFsT3B0aW9ucy5zdWNjZXNzUmVzcG9uc2VzO1xuICAvLyBUaGlzIHdpbGwgYnlwYXNzIG9wdGlvbnMubmV0d29ya1RpbWVvdXQgaWYgaXQncyBzZXQgdG8gYSBmYWxzZS15IHZhbHVlIGxpa2VcbiAgLy8gMCwgYnV0IHRoYXQncyB0aGUgc2FuZSB0aGluZyB0byBkbyBhbnl3YXkuXG4gIHZhciBuZXR3b3JrVGltZW91dFNlY29uZHMgPSBvcHRpb25zLm5ldHdvcmtUaW1lb3V0U2Vjb25kcyB8fFxuICAgICAgZ2xvYmFsT3B0aW9ucy5uZXR3b3JrVGltZW91dFNlY29uZHM7XG4gIGhlbHBlcnMuZGVidWcoJ1N0cmF0ZWd5OiBuZXR3b3JrIGZpcnN0IFsnICsgcmVxdWVzdC51cmwgKyAnXScsIG9wdGlvbnMpO1xuXG4gIHJldHVybiBoZWxwZXJzLm9wZW5DYWNoZShvcHRpb25zKS50aGVuKGZ1bmN0aW9uKGNhY2hlKSB7XG4gICAgdmFyIHRpbWVvdXRJZDtcbiAgICB2YXIgcHJvbWlzZXMgPSBbXTtcbiAgICB2YXIgb3JpZ2luYWxSZXNwb25zZTtcblxuICAgIGlmIChuZXR3b3JrVGltZW91dFNlY29uZHMpIHtcbiAgICAgIHZhciBjYWNoZVdoZW5UaW1lZE91dFByb21pc2UgPSBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlKSB7XG4gICAgICAgIHRpbWVvdXRJZCA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgICAgY2FjaGUubWF0Y2gocmVxdWVzdCkudGhlbihmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgICAgICAgaWYgKHJlc3BvbnNlKSB7XG4gICAgICAgICAgICAgIC8vIE9ubHkgcmVzb2x2ZSB0aGlzIHByb21pc2UgaWYgdGhlcmUncyBhIHZhbGlkIHJlc3BvbnNlIGluIHRoZVxuICAgICAgICAgICAgICAvLyBjYWNoZS4gVGhpcyBlbnN1cmVzIHRoYXQgd2Ugd29uJ3QgdGltZSBvdXQgYSBuZXR3b3JrIHJlcXVlc3RcbiAgICAgICAgICAgICAgLy8gdW5sZXNzIHRoZXJlJ3MgYSBjYWNoZWQgZW50cnkgdG8gZmFsbGJhY2sgb24sIHdoaWNoIGlzIGFyZ3VhYmx5XG4gICAgICAgICAgICAgIC8vIHRoZSBwcmVmZXJhYmxlIGJlaGF2aW9yLlxuICAgICAgICAgICAgICByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgfSwgbmV0d29ya1RpbWVvdXRTZWNvbmRzICogMTAwMCk7XG4gICAgICB9KTtcbiAgICAgIHByb21pc2VzLnB1c2goY2FjaGVXaGVuVGltZWRPdXRQcm9taXNlKTtcbiAgICB9XG5cbiAgICB2YXIgbmV0d29ya1Byb21pc2UgPSBoZWxwZXJzLmZldGNoQW5kQ2FjaGUocmVxdWVzdCwgb3B0aW9ucylcbiAgICAgIC50aGVuKGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gICAgICAgIC8vIFdlJ3ZlIGdvdCBhIHJlc3BvbnNlLCBzbyBjbGVhciB0aGUgbmV0d29yayB0aW1lb3V0IGlmIHRoZXJlIGlzIG9uZS5cbiAgICAgICAgaWYgKHRpbWVvdXRJZCkge1xuICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0SWQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3NSZXNwb25zZXMudGVzdChyZXNwb25zZS5zdGF0dXMpKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgICB9XG5cbiAgICAgICAgaGVscGVycy5kZWJ1ZygnUmVzcG9uc2Ugd2FzIGFuIEhUVFAgZXJyb3I6ICcgKyByZXNwb25zZS5zdGF0dXNUZXh0LFxuICAgICAgICAgICAgb3B0aW9ucyk7XG4gICAgICAgIG9yaWdpbmFsUmVzcG9uc2UgPSByZXNwb25zZTtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdCYWQgcmVzcG9uc2UnKTtcbiAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uKGVycm9yKSB7XG4gICAgICAgIGhlbHBlcnMuZGVidWcoJ05ldHdvcmsgb3IgcmVzcG9uc2UgZXJyb3IsIGZhbGxiYWNrIHRvIGNhY2hlIFsnICtcbiAgICAgICAgICAgIHJlcXVlc3QudXJsICsgJ10nLCBvcHRpb25zKTtcbiAgICAgICAgcmV0dXJuIGNhY2hlLm1hdGNoKHJlcXVlc3QpLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgICAgICAgICAvLyBJZiB0aGVyZSdzIGEgbWF0Y2ggaW4gdGhlIGNhY2hlLCByZXNvbHZlIHdpdGggdGhhdC5cbiAgICAgICAgICBpZiAocmVzcG9uc2UpIHtcbiAgICAgICAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBJZiB3ZSBoYXZlIGEgUmVzcG9uc2Ugb2JqZWN0IGZyb20gdGhlIHByZXZpb3VzIGZldGNoLCB0aGVuIHJlc29sdmVcbiAgICAgICAgICAvLyB3aXRoIHRoYXQsIGV2ZW4gdGhvdWdoIGl0IGNvcnJlc3BvbmRzIHRvIGFuIGVycm9yIHN0YXR1cyBjb2RlLlxuICAgICAgICAgIGlmIChvcmlnaW5hbFJlc3BvbnNlKSB7XG4gICAgICAgICAgICByZXR1cm4gb3JpZ2luYWxSZXNwb25zZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBJZiB3ZSBkb24ndCBoYXZlIGEgUmVzcG9uc2Ugb2JqZWN0IGZyb20gdGhlIHByZXZpb3VzIGZldGNoLCBsaWtlbHlcbiAgICAgICAgICAvLyBkdWUgdG8gYSBuZXR3b3JrIGZhaWx1cmUsIHRoZW4gcmVqZWN0IHdpdGggdGhlIGZhaWx1cmUgZXJyb3IuXG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG5cbiAgICBwcm9taXNlcy5wdXNoKG5ldHdvcmtQcm9taXNlKTtcblxuICAgIHJldHVybiBQcm9taXNlLnJhY2UocHJvbWlzZXMpO1xuICB9KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBuZXR3b3JrRmlyc3Q7XG4iLCIvKlxuXHRDb3B5cmlnaHQgMjAxNCBHb29nbGUgSW5jLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxuXG5cdExpY2Vuc2VkIHVuZGVyIHRoZSBBcGFjaGUgTGljZW5zZSwgVmVyc2lvbiAyLjAgKHRoZSBcIkxpY2Vuc2VcIik7XG5cdHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cblx0WW91IG1heSBvYnRhaW4gYSBjb3B5IG9mIHRoZSBMaWNlbnNlIGF0XG5cbiAgICAgIGh0dHA6Ly93d3cuYXBhY2hlLm9yZy9saWNlbnNlcy9MSUNFTlNFLTIuMFxuXG5cdFVubGVzcyByZXF1aXJlZCBieSBhcHBsaWNhYmxlIGxhdyBvciBhZ3JlZWQgdG8gaW4gd3JpdGluZywgc29mdHdhcmVcblx0ZGlzdHJpYnV0ZWQgdW5kZXIgdGhlIExpY2Vuc2UgaXMgZGlzdHJpYnV0ZWQgb24gYW4gXCJBUyBJU1wiIEJBU0lTLFxuXHRXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cblx0U2VlIHRoZSBMaWNlbnNlIGZvciB0aGUgc3BlY2lmaWMgbGFuZ3VhZ2UgZ292ZXJuaW5nIHBlcm1pc3Npb25zIGFuZFxuXHRsaW1pdGF0aW9ucyB1bmRlciB0aGUgTGljZW5zZS5cbiovXG4ndXNlIHN0cmljdCc7XG52YXIgaGVscGVycyA9IHJlcXVpcmUoJy4uL2hlbHBlcnMnKTtcblxuZnVuY3Rpb24gbmV0d29ya09ubHkocmVxdWVzdCwgdmFsdWVzLCBvcHRpb25zKSB7XG4gIGhlbHBlcnMuZGVidWcoJ1N0cmF0ZWd5OiBuZXR3b3JrIG9ubHkgWycgKyByZXF1ZXN0LnVybCArICddJywgb3B0aW9ucyk7XG4gIHJldHVybiBmZXRjaChyZXF1ZXN0KTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBuZXR3b3JrT25seTtcbiIsIi8qXG4gIENvcHlyaWdodCAyMDE0IEdvb2dsZSBJbmMuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuXG5cbiAgTGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcbiAgeW91IG1heSBub3QgdXNlIHRoaXMgZmlsZSBleGNlcHQgaW4gY29tcGxpYW5jZSB3aXRoIHRoZSBMaWNlbnNlLlxuICBZb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXRcblxuICAgICAgaHR0cDovL3d3dy5hcGFjaGUub3JnL2xpY2Vuc2VzL0xJQ0VOU0UtMi4wXG5cbiAgVW5sZXNzIHJlcXVpcmVkIGJ5IGFwcGxpY2FibGUgbGF3IG9yIGFncmVlZCB0byBpbiB3cml0aW5nLCBzb2Z0d2FyZVxuICBkaXN0cmlidXRlZCB1bmRlciB0aGUgTGljZW5zZSBpcyBkaXN0cmlidXRlZCBvbiBhbiBcIkFTIElTXCIgQkFTSVMsXG4gIFdJVEhPVVQgV0FSUkFOVElFUyBPUiBDT05ESVRJT05TIE9GIEFOWSBLSU5ELCBlaXRoZXIgZXhwcmVzcyBvciBpbXBsaWVkLlxuICBTZWUgdGhlIExpY2Vuc2UgZm9yIHRoZSBzcGVjaWZpYyBsYW5ndWFnZSBnb3Zlcm5pbmcgcGVybWlzc2lvbnMgYW5kXG4gIGxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLlxuKi9cbid1c2Ugc3RyaWN0JztcblxucmVxdWlyZSgnc2VydmljZXdvcmtlci1jYWNoZS1wb2x5ZmlsbCcpO1xudmFyIG9wdGlvbnMgPSByZXF1aXJlKCcuL29wdGlvbnMnKTtcbnZhciByb3V0ZXIgPSByZXF1aXJlKCcuL3JvdXRlcicpO1xudmFyIGhlbHBlcnMgPSByZXF1aXJlKCcuL2hlbHBlcnMnKTtcbnZhciBzdHJhdGVnaWVzID0gcmVxdWlyZSgnLi9zdHJhdGVnaWVzJyk7XG5cbmhlbHBlcnMuZGVidWcoJ1NlcnZpY2UgV29ya2VyIFRvb2xib3ggaXMgbG9hZGluZycpO1xuXG4vLyBJbnN0YWxsXG52YXIgZmxhdHRlbiA9IGZ1bmN0aW9uKGl0ZW1zKSB7XG4gIHJldHVybiBpdGVtcy5yZWR1Y2UoZnVuY3Rpb24oYSwgYikge1xuICAgIHJldHVybiBhLmNvbmNhdChiKTtcbiAgfSwgW10pO1xufTtcblxudmFyIHZhbGlkYXRlUHJlY2FjaGVJbnB1dCA9IGZ1bmN0aW9uKGl0ZW1zKSB7XG4gIHZhciBpc1ZhbGlkID0gQXJyYXkuaXNBcnJheShpdGVtcyk7XG4gIGlmIChpc1ZhbGlkKSB7XG4gICAgaXRlbXMuZm9yRWFjaChmdW5jdGlvbihpdGVtKSB7XG4gICAgICBpZiAoISh0eXBlb2YgaXRlbSA9PT0gJ3N0cmluZycgfHwgKGl0ZW0gaW5zdGFuY2VvZiBSZXF1ZXN0KSkpIHtcbiAgICAgICAgaXNWYWxpZCA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgaWYgKCFpc1ZhbGlkKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcignVGhlIHByZWNhY2hlIG1ldGhvZCBleHBlY3RzIGVpdGhlciBhbiBhcnJheSBvZiAnICtcbiAgICAnc3RyaW5ncyBhbmQvb3IgUmVxdWVzdHMgb3IgYSBQcm9taXNlIHRoYXQgcmVzb2x2ZXMgdG8gYW4gYXJyYXkgb2YgJyArXG4gICAgJ3N0cmluZ3MgYW5kL29yIFJlcXVlc3RzLicpO1xuICB9XG5cbiAgcmV0dXJuIGl0ZW1zO1xufTtcblxuc2VsZi5hZGRFdmVudExpc3RlbmVyKCdpbnN0YWxsJywgZnVuY3Rpb24oZXZlbnQpIHtcbiAgdmFyIGluYWN0aXZlQ2FjaGUgPSBvcHRpb25zLmNhY2hlLm5hbWUgKyAnJCQkaW5hY3RpdmUkJCQnO1xuICBoZWxwZXJzLmRlYnVnKCdpbnN0YWxsIGV2ZW50IGZpcmVkJyk7XG4gIGhlbHBlcnMuZGVidWcoJ2NyZWF0aW5nIGNhY2hlIFsnICsgaW5hY3RpdmVDYWNoZSArICddJyk7XG4gIGV2ZW50LndhaXRVbnRpbChcbiAgICBoZWxwZXJzLm9wZW5DYWNoZSh7Y2FjaGU6IHtuYW1lOiBpbmFjdGl2ZUNhY2hlfX0pXG4gICAgLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChvcHRpb25zLnByZUNhY2hlSXRlbXMpXG4gICAgICAudGhlbihmbGF0dGVuKVxuICAgICAgLnRoZW4odmFsaWRhdGVQcmVjYWNoZUlucHV0KVxuICAgICAgLnRoZW4oZnVuY3Rpb24ocHJlQ2FjaGVJdGVtcykge1xuICAgICAgICBoZWxwZXJzLmRlYnVnKCdwcmVDYWNoZSBsaXN0OiAnICtcbiAgICAgICAgICAgIChwcmVDYWNoZUl0ZW1zLmpvaW4oJywgJykgfHwgJyhub25lKScpKTtcbiAgICAgICAgcmV0dXJuIGNhY2hlLmFkZEFsbChwcmVDYWNoZUl0ZW1zKTtcbiAgICAgIH0pO1xuICAgIH0pXG4gICk7XG59KTtcblxuLy8gQWN0aXZhdGVcblxuc2VsZi5hZGRFdmVudExpc3RlbmVyKCdhY3RpdmF0ZScsIGZ1bmN0aW9uKGV2ZW50KSB7XG4gIGhlbHBlcnMuZGVidWcoJ2FjdGl2YXRlIGV2ZW50IGZpcmVkJyk7XG4gIHZhciBpbmFjdGl2ZUNhY2hlID0gb3B0aW9ucy5jYWNoZS5uYW1lICsgJyQkJGluYWN0aXZlJCQkJztcbiAgZXZlbnQud2FpdFVudGlsKGhlbHBlcnMucmVuYW1lQ2FjaGUoaW5hY3RpdmVDYWNoZSwgb3B0aW9ucy5jYWNoZS5uYW1lKSk7XG59KTtcblxuLy8gRmV0Y2hcblxuc2VsZi5hZGRFdmVudExpc3RlbmVyKCdmZXRjaCcsIGZ1bmN0aW9uKGV2ZW50KSB7XG4gIHZhciBoYW5kbGVyID0gcm91dGVyLm1hdGNoKGV2ZW50LnJlcXVlc3QpO1xuXG4gIGlmIChoYW5kbGVyKSB7XG4gICAgZXZlbnQucmVzcG9uZFdpdGgoaGFuZGxlcihldmVudC5yZXF1ZXN0KSk7XG4gIH0gZWxzZSBpZiAocm91dGVyLmRlZmF1bHQgJiYgZXZlbnQucmVxdWVzdC5tZXRob2QgPT09ICdHRVQnKSB7XG4gICAgZXZlbnQucmVzcG9uZFdpdGgocm91dGVyLmRlZmF1bHQoZXZlbnQucmVxdWVzdCkpO1xuICB9XG59KTtcblxuLy8gQ2FjaGluZ1xuXG5mdW5jdGlvbiBjYWNoZSh1cmwsIG9wdGlvbnMpIHtcbiAgcmV0dXJuIGhlbHBlcnMub3BlbkNhY2hlKG9wdGlvbnMpLnRoZW4oZnVuY3Rpb24oY2FjaGUpIHtcbiAgICByZXR1cm4gY2FjaGUuYWRkKHVybCk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiB1bmNhY2hlKHVybCwgb3B0aW9ucykge1xuICByZXR1cm4gaGVscGVycy5vcGVuQ2FjaGUob3B0aW9ucykudGhlbihmdW5jdGlvbihjYWNoZSkge1xuICAgIHJldHVybiBjYWNoZS5kZWxldGUodXJsKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHByZWNhY2hlKGl0ZW1zKSB7XG4gIGlmICghKGl0ZW1zIGluc3RhbmNlb2YgUHJvbWlzZSkpIHtcbiAgICB2YWxpZGF0ZVByZWNhY2hlSW5wdXQoaXRlbXMpO1xuICB9XG5cbiAgb3B0aW9ucy5wcmVDYWNoZUl0ZW1zID0gb3B0aW9ucy5wcmVDYWNoZUl0ZW1zLmNvbmNhdChpdGVtcyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICBuZXR3b3JrT25seTogc3RyYXRlZ2llcy5uZXR3b3JrT25seSxcbiAgbmV0d29ya0ZpcnN0OiBzdHJhdGVnaWVzLm5ldHdvcmtGaXJzdCxcbiAgY2FjaGVPbmx5OiBzdHJhdGVnaWVzLmNhY2hlT25seSxcbiAgY2FjaGVGaXJzdDogc3RyYXRlZ2llcy5jYWNoZUZpcnN0LFxuICBmYXN0ZXN0OiBzdHJhdGVnaWVzLmZhc3Rlc3QsXG4gIHJvdXRlcjogcm91dGVyLFxuICBvcHRpb25zOiBvcHRpb25zLFxuICBjYWNoZTogY2FjaGUsXG4gIHVuY2FjaGU6IHVuY2FjaGUsXG4gIHByZWNhY2hlOiBwcmVjYWNoZVxufTtcbiIsInZhciBpc2FycmF5ID0gcmVxdWlyZSgnaXNhcnJheScpXG5cbi8qKlxuICogRXhwb3NlIGBwYXRoVG9SZWdleHBgLlxuICovXG5tb2R1bGUuZXhwb3J0cyA9IHBhdGhUb1JlZ2V4cFxubW9kdWxlLmV4cG9ydHMucGFyc2UgPSBwYXJzZVxubW9kdWxlLmV4cG9ydHMuY29tcGlsZSA9IGNvbXBpbGVcbm1vZHVsZS5leHBvcnRzLnRva2Vuc1RvRnVuY3Rpb24gPSB0b2tlbnNUb0Z1bmN0aW9uXG5tb2R1bGUuZXhwb3J0cy50b2tlbnNUb1JlZ0V4cCA9IHRva2Vuc1RvUmVnRXhwXG5cbi8qKlxuICogVGhlIG1haW4gcGF0aCBtYXRjaGluZyByZWdleHAgdXRpbGl0eS5cbiAqXG4gKiBAdHlwZSB7UmVnRXhwfVxuICovXG52YXIgUEFUSF9SRUdFWFAgPSBuZXcgUmVnRXhwKFtcbiAgLy8gTWF0Y2ggZXNjYXBlZCBjaGFyYWN0ZXJzIHRoYXQgd291bGQgb3RoZXJ3aXNlIGFwcGVhciBpbiBmdXR1cmUgbWF0Y2hlcy5cbiAgLy8gVGhpcyBhbGxvd3MgdGhlIHVzZXIgdG8gZXNjYXBlIHNwZWNpYWwgY2hhcmFjdGVycyB0aGF0IHdvbid0IHRyYW5zZm9ybS5cbiAgJyhcXFxcXFxcXC4pJyxcbiAgLy8gTWF0Y2ggRXhwcmVzcy1zdHlsZSBwYXJhbWV0ZXJzIGFuZCB1bi1uYW1lZCBwYXJhbWV0ZXJzIHdpdGggYSBwcmVmaXhcbiAgLy8gYW5kIG9wdGlvbmFsIHN1ZmZpeGVzLiBNYXRjaGVzIGFwcGVhciBhczpcbiAgLy9cbiAgLy8gXCIvOnRlc3QoXFxcXGQrKT9cIiA9PiBbXCIvXCIsIFwidGVzdFwiLCBcIlxcZCtcIiwgdW5kZWZpbmVkLCBcIj9cIiwgdW5kZWZpbmVkXVxuICAvLyBcIi9yb3V0ZShcXFxcZCspXCIgID0+IFt1bmRlZmluZWQsIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBcIlxcZCtcIiwgdW5kZWZpbmVkLCB1bmRlZmluZWRdXG4gIC8vIFwiLypcIiAgICAgICAgICAgID0+IFtcIi9cIiwgdW5kZWZpbmVkLCB1bmRlZmluZWQsIHVuZGVmaW5lZCwgdW5kZWZpbmVkLCBcIipcIl1cbiAgJyhbXFxcXC8uXSk/KD86KD86XFxcXDooXFxcXHcrKSg/OlxcXFwoKCg/OlxcXFxcXFxcLnxbXlxcXFxcXFxcKCldKSspXFxcXCkpP3xcXFxcKCgoPzpcXFxcXFxcXC58W15cXFxcXFxcXCgpXSkrKVxcXFwpKShbKyo/XSk/fChcXFxcKikpJ1xuXS5qb2luKCd8JyksICdnJylcblxuLyoqXG4gKiBQYXJzZSBhIHN0cmluZyBmb3IgdGhlIHJhdyB0b2tlbnMuXG4gKlxuICogQHBhcmFtICB7c3RyaW5nfSBzdHJcbiAqIEByZXR1cm4geyFBcnJheX1cbiAqL1xuZnVuY3Rpb24gcGFyc2UgKHN0cikge1xuICB2YXIgdG9rZW5zID0gW11cbiAgdmFyIGtleSA9IDBcbiAgdmFyIGluZGV4ID0gMFxuICB2YXIgcGF0aCA9ICcnXG4gIHZhciByZXNcblxuICB3aGlsZSAoKHJlcyA9IFBBVEhfUkVHRVhQLmV4ZWMoc3RyKSkgIT0gbnVsbCkge1xuICAgIHZhciBtID0gcmVzWzBdXG4gICAgdmFyIGVzY2FwZWQgPSByZXNbMV1cbiAgICB2YXIgb2Zmc2V0ID0gcmVzLmluZGV4XG4gICAgcGF0aCArPSBzdHIuc2xpY2UoaW5kZXgsIG9mZnNldClcbiAgICBpbmRleCA9IG9mZnNldCArIG0ubGVuZ3RoXG5cbiAgICAvLyBJZ25vcmUgYWxyZWFkeSBlc2NhcGVkIHNlcXVlbmNlcy5cbiAgICBpZiAoZXNjYXBlZCkge1xuICAgICAgcGF0aCArPSBlc2NhcGVkWzFdXG4gICAgICBjb250aW51ZVxuICAgIH1cblxuICAgIHZhciBuZXh0ID0gc3RyW2luZGV4XVxuICAgIHZhciBwcmVmaXggPSByZXNbMl1cbiAgICB2YXIgbmFtZSA9IHJlc1szXVxuICAgIHZhciBjYXB0dXJlID0gcmVzWzRdXG4gICAgdmFyIGdyb3VwID0gcmVzWzVdXG4gICAgdmFyIG1vZGlmaWVyID0gcmVzWzZdXG4gICAgdmFyIGFzdGVyaXNrID0gcmVzWzddXG5cbiAgICAvLyBQdXNoIHRoZSBjdXJyZW50IHBhdGggb250byB0aGUgdG9rZW5zLlxuICAgIGlmIChwYXRoKSB7XG4gICAgICB0b2tlbnMucHVzaChwYXRoKVxuICAgICAgcGF0aCA9ICcnXG4gICAgfVxuXG4gICAgdmFyIHBhcnRpYWwgPSBwcmVmaXggIT0gbnVsbCAmJiBuZXh0ICE9IG51bGwgJiYgbmV4dCAhPT0gcHJlZml4XG4gICAgdmFyIHJlcGVhdCA9IG1vZGlmaWVyID09PSAnKycgfHwgbW9kaWZpZXIgPT09ICcqJ1xuICAgIHZhciBvcHRpb25hbCA9IG1vZGlmaWVyID09PSAnPycgfHwgbW9kaWZpZXIgPT09ICcqJ1xuICAgIHZhciBkZWxpbWl0ZXIgPSByZXNbMl0gfHwgJy8nXG4gICAgdmFyIHBhdHRlcm4gPSBjYXB0dXJlIHx8IGdyb3VwIHx8IChhc3RlcmlzayA/ICcuKicgOiAnW14nICsgZGVsaW1pdGVyICsgJ10rPycpXG5cbiAgICB0b2tlbnMucHVzaCh7XG4gICAgICBuYW1lOiBuYW1lIHx8IGtleSsrLFxuICAgICAgcHJlZml4OiBwcmVmaXggfHwgJycsXG4gICAgICBkZWxpbWl0ZXI6IGRlbGltaXRlcixcbiAgICAgIG9wdGlvbmFsOiBvcHRpb25hbCxcbiAgICAgIHJlcGVhdDogcmVwZWF0LFxuICAgICAgcGFydGlhbDogcGFydGlhbCxcbiAgICAgIGFzdGVyaXNrOiAhIWFzdGVyaXNrLFxuICAgICAgcGF0dGVybjogZXNjYXBlR3JvdXAocGF0dGVybilcbiAgICB9KVxuICB9XG5cbiAgLy8gTWF0Y2ggYW55IGNoYXJhY3RlcnMgc3RpbGwgcmVtYWluaW5nLlxuICBpZiAoaW5kZXggPCBzdHIubGVuZ3RoKSB7XG4gICAgcGF0aCArPSBzdHIuc3Vic3RyKGluZGV4KVxuICB9XG5cbiAgLy8gSWYgdGhlIHBhdGggZXhpc3RzLCBwdXNoIGl0IG9udG8gdGhlIGVuZC5cbiAgaWYgKHBhdGgpIHtcbiAgICB0b2tlbnMucHVzaChwYXRoKVxuICB9XG5cbiAgcmV0dXJuIHRva2Vuc1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBzdHJpbmcgdG8gYSB0ZW1wbGF0ZSBmdW5jdGlvbiBmb3IgdGhlIHBhdGguXG4gKlxuICogQHBhcmFtICB7c3RyaW5nfSAgICAgICAgICAgICBzdHJcbiAqIEByZXR1cm4geyFmdW5jdGlvbihPYmplY3Q9LCBPYmplY3Q9KX1cbiAqL1xuZnVuY3Rpb24gY29tcGlsZSAoc3RyKSB7XG4gIHJldHVybiB0b2tlbnNUb0Z1bmN0aW9uKHBhcnNlKHN0cikpXG59XG5cbi8qKlxuICogUHJldHRpZXIgZW5jb2Rpbmcgb2YgVVJJIHBhdGggc2VnbWVudHMuXG4gKlxuICogQHBhcmFtICB7c3RyaW5nfVxuICogQHJldHVybiB7c3RyaW5nfVxuICovXG5mdW5jdGlvbiBlbmNvZGVVUklDb21wb25lbnRQcmV0dHkgKHN0cikge1xuICByZXR1cm4gZW5jb2RlVVJJKHN0cikucmVwbGFjZSgvW1xcLz8jXS9nLCBmdW5jdGlvbiAoYykge1xuICAgIHJldHVybiAnJScgKyBjLmNoYXJDb2RlQXQoMCkudG9TdHJpbmcoMTYpLnRvVXBwZXJDYXNlKClcbiAgfSlcbn1cblxuLyoqXG4gKiBFbmNvZGUgdGhlIGFzdGVyaXNrIHBhcmFtZXRlci4gU2ltaWxhciB0byBgcHJldHR5YCwgYnV0IGFsbG93cyBzbGFzaGVzLlxuICpcbiAqIEBwYXJhbSAge3N0cmluZ31cbiAqIEByZXR1cm4ge3N0cmluZ31cbiAqL1xuZnVuY3Rpb24gZW5jb2RlQXN0ZXJpc2sgKHN0cikge1xuICByZXR1cm4gZW5jb2RlVVJJKHN0cikucmVwbGFjZSgvWz8jXS9nLCBmdW5jdGlvbiAoYykge1xuICAgIHJldHVybiAnJScgKyBjLmNoYXJDb2RlQXQoMCkudG9TdHJpbmcoMTYpLnRvVXBwZXJDYXNlKClcbiAgfSlcbn1cblxuLyoqXG4gKiBFeHBvc2UgYSBtZXRob2QgZm9yIHRyYW5zZm9ybWluZyB0b2tlbnMgaW50byB0aGUgcGF0aCBmdW5jdGlvbi5cbiAqL1xuZnVuY3Rpb24gdG9rZW5zVG9GdW5jdGlvbiAodG9rZW5zKSB7XG4gIC8vIENvbXBpbGUgYWxsIHRoZSB0b2tlbnMgaW50byByZWdleHBzLlxuICB2YXIgbWF0Y2hlcyA9IG5ldyBBcnJheSh0b2tlbnMubGVuZ3RoKVxuXG4gIC8vIENvbXBpbGUgYWxsIHRoZSBwYXR0ZXJucyBiZWZvcmUgY29tcGlsYXRpb24uXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdG9rZW5zLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKHR5cGVvZiB0b2tlbnNbaV0gPT09ICdvYmplY3QnKSB7XG4gICAgICBtYXRjaGVzW2ldID0gbmV3IFJlZ0V4cCgnXig/OicgKyB0b2tlbnNbaV0ucGF0dGVybiArICcpJCcpXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIChvYmosIG9wdHMpIHtcbiAgICB2YXIgcGF0aCA9ICcnXG4gICAgdmFyIGRhdGEgPSBvYmogfHwge31cbiAgICB2YXIgb3B0aW9ucyA9IG9wdHMgfHwge31cbiAgICB2YXIgZW5jb2RlID0gb3B0aW9ucy5wcmV0dHkgPyBlbmNvZGVVUklDb21wb25lbnRQcmV0dHkgOiBlbmNvZGVVUklDb21wb25lbnRcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdG9rZW5zLmxlbmd0aDsgaSsrKSB7XG4gICAgICB2YXIgdG9rZW4gPSB0b2tlbnNbaV1cblxuICAgICAgaWYgKHR5cGVvZiB0b2tlbiA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgcGF0aCArPSB0b2tlblxuXG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG5cbiAgICAgIHZhciB2YWx1ZSA9IGRhdGFbdG9rZW4ubmFtZV1cbiAgICAgIHZhciBzZWdtZW50XG5cbiAgICAgIGlmICh2YWx1ZSA9PSBudWxsKSB7XG4gICAgICAgIGlmICh0b2tlbi5vcHRpb25hbCkge1xuICAgICAgICAgIC8vIFByZXBlbmQgcGFydGlhbCBzZWdtZW50IHByZWZpeGVzLlxuICAgICAgICAgIGlmICh0b2tlbi5wYXJ0aWFsKSB7XG4gICAgICAgICAgICBwYXRoICs9IHRva2VuLnByZWZpeFxuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignRXhwZWN0ZWQgXCInICsgdG9rZW4ubmFtZSArICdcIiB0byBiZSBkZWZpbmVkJylcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoaXNhcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgaWYgKCF0b2tlbi5yZXBlYXQpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdFeHBlY3RlZCBcIicgKyB0b2tlbi5uYW1lICsgJ1wiIHRvIG5vdCByZXBlYXQsIGJ1dCByZWNlaXZlZCBgJyArIEpTT04uc3RyaW5naWZ5KHZhbHVlKSArICdgJylcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh2YWx1ZS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICBpZiAodG9rZW4ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoJ0V4cGVjdGVkIFwiJyArIHRva2VuLm5hbWUgKyAnXCIgdG8gbm90IGJlIGVtcHR5JylcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IHZhbHVlLmxlbmd0aDsgaisrKSB7XG4gICAgICAgICAgc2VnbWVudCA9IGVuY29kZSh2YWx1ZVtqXSlcblxuICAgICAgICAgIGlmICghbWF0Y2hlc1tpXS50ZXN0KHNlZ21lbnQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCdFeHBlY3RlZCBhbGwgXCInICsgdG9rZW4ubmFtZSArICdcIiB0byBtYXRjaCBcIicgKyB0b2tlbi5wYXR0ZXJuICsgJ1wiLCBidXQgcmVjZWl2ZWQgYCcgKyBKU09OLnN0cmluZ2lmeShzZWdtZW50KSArICdgJylcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBwYXRoICs9IChqID09PSAwID8gdG9rZW4ucHJlZml4IDogdG9rZW4uZGVsaW1pdGVyKSArIHNlZ21lbnRcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG5cbiAgICAgIHNlZ21lbnQgPSB0b2tlbi5hc3RlcmlzayA/IGVuY29kZUFzdGVyaXNrKHZhbHVlKSA6IGVuY29kZSh2YWx1ZSlcblxuICAgICAgaWYgKCFtYXRjaGVzW2ldLnRlc3Qoc2VnbWVudCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcignRXhwZWN0ZWQgXCInICsgdG9rZW4ubmFtZSArICdcIiB0byBtYXRjaCBcIicgKyB0b2tlbi5wYXR0ZXJuICsgJ1wiLCBidXQgcmVjZWl2ZWQgXCInICsgc2VnbWVudCArICdcIicpXG4gICAgICB9XG5cbiAgICAgIHBhdGggKz0gdG9rZW4ucHJlZml4ICsgc2VnbWVudFxuICAgIH1cblxuICAgIHJldHVybiBwYXRoXG4gIH1cbn1cblxuLyoqXG4gKiBFc2NhcGUgYSByZWd1bGFyIGV4cHJlc3Npb24gc3RyaW5nLlxuICpcbiAqIEBwYXJhbSAge3N0cmluZ30gc3RyXG4gKiBAcmV0dXJuIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGVzY2FwZVN0cmluZyAoc3RyKSB7XG4gIHJldHVybiBzdHIucmVwbGFjZSgvKFsuKyo/PV4hOiR7fSgpW1xcXXxcXC9cXFxcXSkvZywgJ1xcXFwkMScpXG59XG5cbi8qKlxuICogRXNjYXBlIHRoZSBjYXB0dXJpbmcgZ3JvdXAgYnkgZXNjYXBpbmcgc3BlY2lhbCBjaGFyYWN0ZXJzIGFuZCBtZWFuaW5nLlxuICpcbiAqIEBwYXJhbSAge3N0cmluZ30gZ3JvdXBcbiAqIEByZXR1cm4ge3N0cmluZ31cbiAqL1xuZnVuY3Rpb24gZXNjYXBlR3JvdXAgKGdyb3VwKSB7XG4gIHJldHVybiBncm91cC5yZXBsYWNlKC8oWz0hOiRcXC8oKV0pL2csICdcXFxcJDEnKVxufVxuXG4vKipcbiAqIEF0dGFjaCB0aGUga2V5cyBhcyBhIHByb3BlcnR5IG9mIHRoZSByZWdleHAuXG4gKlxuICogQHBhcmFtICB7IVJlZ0V4cH0gcmVcbiAqIEBwYXJhbSAge0FycmF5fSAgIGtleXNcbiAqIEByZXR1cm4geyFSZWdFeHB9XG4gKi9cbmZ1bmN0aW9uIGF0dGFjaEtleXMgKHJlLCBrZXlzKSB7XG4gIHJlLmtleXMgPSBrZXlzXG4gIHJldHVybiByZVxufVxuXG4vKipcbiAqIEdldCB0aGUgZmxhZ3MgZm9yIGEgcmVnZXhwIGZyb20gdGhlIG9wdGlvbnMuXG4gKlxuICogQHBhcmFtICB7T2JqZWN0fSBvcHRpb25zXG4gKiBAcmV0dXJuIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGZsYWdzIChvcHRpb25zKSB7XG4gIHJldHVybiBvcHRpb25zLnNlbnNpdGl2ZSA/ICcnIDogJ2knXG59XG5cbi8qKlxuICogUHVsbCBvdXQga2V5cyBmcm9tIGEgcmVnZXhwLlxuICpcbiAqIEBwYXJhbSAgeyFSZWdFeHB9IHBhdGhcbiAqIEBwYXJhbSAgeyFBcnJheX0gIGtleXNcbiAqIEByZXR1cm4geyFSZWdFeHB9XG4gKi9cbmZ1bmN0aW9uIHJlZ2V4cFRvUmVnZXhwIChwYXRoLCBrZXlzKSB7XG4gIC8vIFVzZSBhIG5lZ2F0aXZlIGxvb2thaGVhZCB0byBtYXRjaCBvbmx5IGNhcHR1cmluZyBncm91cHMuXG4gIHZhciBncm91cHMgPSBwYXRoLnNvdXJjZS5tYXRjaCgvXFwoKD8hXFw/KS9nKVxuXG4gIGlmIChncm91cHMpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGdyb3Vwcy5sZW5ndGg7IGkrKykge1xuICAgICAga2V5cy5wdXNoKHtcbiAgICAgICAgbmFtZTogaSxcbiAgICAgICAgcHJlZml4OiBudWxsLFxuICAgICAgICBkZWxpbWl0ZXI6IG51bGwsXG4gICAgICAgIG9wdGlvbmFsOiBmYWxzZSxcbiAgICAgICAgcmVwZWF0OiBmYWxzZSxcbiAgICAgICAgcGFydGlhbDogZmFsc2UsXG4gICAgICAgIGFzdGVyaXNrOiBmYWxzZSxcbiAgICAgICAgcGF0dGVybjogbnVsbFxuICAgICAgfSlcbiAgICB9XG4gIH1cblxuICByZXR1cm4gYXR0YWNoS2V5cyhwYXRoLCBrZXlzKVxufVxuXG4vKipcbiAqIFRyYW5zZm9ybSBhbiBhcnJheSBpbnRvIGEgcmVnZXhwLlxuICpcbiAqIEBwYXJhbSAgeyFBcnJheX0gIHBhdGhcbiAqIEBwYXJhbSAge0FycmF5fSAgIGtleXNcbiAqIEBwYXJhbSAgeyFPYmplY3R9IG9wdGlvbnNcbiAqIEByZXR1cm4geyFSZWdFeHB9XG4gKi9cbmZ1bmN0aW9uIGFycmF5VG9SZWdleHAgKHBhdGgsIGtleXMsIG9wdGlvbnMpIHtcbiAgdmFyIHBhcnRzID0gW11cblxuICBmb3IgKHZhciBpID0gMDsgaSA8IHBhdGgubGVuZ3RoOyBpKyspIHtcbiAgICBwYXJ0cy5wdXNoKHBhdGhUb1JlZ2V4cChwYXRoW2ldLCBrZXlzLCBvcHRpb25zKS5zb3VyY2UpXG4gIH1cblxuICB2YXIgcmVnZXhwID0gbmV3IFJlZ0V4cCgnKD86JyArIHBhcnRzLmpvaW4oJ3wnKSArICcpJywgZmxhZ3Mob3B0aW9ucykpXG5cbiAgcmV0dXJuIGF0dGFjaEtleXMocmVnZXhwLCBrZXlzKVxufVxuXG4vKipcbiAqIENyZWF0ZSBhIHBhdGggcmVnZXhwIGZyb20gc3RyaW5nIGlucHV0LlxuICpcbiAqIEBwYXJhbSAge3N0cmluZ30gIHBhdGhcbiAqIEBwYXJhbSAgeyFBcnJheX0gIGtleXNcbiAqIEBwYXJhbSAgeyFPYmplY3R9IG9wdGlvbnNcbiAqIEByZXR1cm4geyFSZWdFeHB9XG4gKi9cbmZ1bmN0aW9uIHN0cmluZ1RvUmVnZXhwIChwYXRoLCBrZXlzLCBvcHRpb25zKSB7XG4gIHZhciB0b2tlbnMgPSBwYXJzZShwYXRoKVxuICB2YXIgcmUgPSB0b2tlbnNUb1JlZ0V4cCh0b2tlbnMsIG9wdGlvbnMpXG5cbiAgLy8gQXR0YWNoIGtleXMgYmFjayB0byB0aGUgcmVnZXhwLlxuICBmb3IgKHZhciBpID0gMDsgaSA8IHRva2Vucy5sZW5ndGg7IGkrKykge1xuICAgIGlmICh0eXBlb2YgdG9rZW5zW2ldICE9PSAnc3RyaW5nJykge1xuICAgICAga2V5cy5wdXNoKHRva2Vuc1tpXSlcbiAgICB9XG4gIH1cblxuICByZXR1cm4gYXR0YWNoS2V5cyhyZSwga2V5cylcbn1cblxuLyoqXG4gKiBFeHBvc2UgYSBmdW5jdGlvbiBmb3IgdGFraW5nIHRva2VucyBhbmQgcmV0dXJuaW5nIGEgUmVnRXhwLlxuICpcbiAqIEBwYXJhbSAgeyFBcnJheX0gIHRva2Vuc1xuICogQHBhcmFtICB7T2JqZWN0PX0gb3B0aW9uc1xuICogQHJldHVybiB7IVJlZ0V4cH1cbiAqL1xuZnVuY3Rpb24gdG9rZW5zVG9SZWdFeHAgKHRva2Vucywgb3B0aW9ucykge1xuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fVxuXG4gIHZhciBzdHJpY3QgPSBvcHRpb25zLnN0cmljdFxuICB2YXIgZW5kID0gb3B0aW9ucy5lbmQgIT09IGZhbHNlXG4gIHZhciByb3V0ZSA9ICcnXG4gIHZhciBsYXN0VG9rZW4gPSB0b2tlbnNbdG9rZW5zLmxlbmd0aCAtIDFdXG4gIHZhciBlbmRzV2l0aFNsYXNoID0gdHlwZW9mIGxhc3RUb2tlbiA9PT0gJ3N0cmluZycgJiYgL1xcLyQvLnRlc3QobGFzdFRva2VuKVxuXG4gIC8vIEl0ZXJhdGUgb3ZlciB0aGUgdG9rZW5zIGFuZCBjcmVhdGUgb3VyIHJlZ2V4cCBzdHJpbmcuXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgdG9rZW5zLmxlbmd0aDsgaSsrKSB7XG4gICAgdmFyIHRva2VuID0gdG9rZW5zW2ldXG5cbiAgICBpZiAodHlwZW9mIHRva2VuID09PSAnc3RyaW5nJykge1xuICAgICAgcm91dGUgKz0gZXNjYXBlU3RyaW5nKHRva2VuKVxuICAgIH0gZWxzZSB7XG4gICAgICB2YXIgcHJlZml4ID0gZXNjYXBlU3RyaW5nKHRva2VuLnByZWZpeClcbiAgICAgIHZhciBjYXB0dXJlID0gJyg/OicgKyB0b2tlbi5wYXR0ZXJuICsgJyknXG5cbiAgICAgIGlmICh0b2tlbi5yZXBlYXQpIHtcbiAgICAgICAgY2FwdHVyZSArPSAnKD86JyArIHByZWZpeCArIGNhcHR1cmUgKyAnKSonXG4gICAgICB9XG5cbiAgICAgIGlmICh0b2tlbi5vcHRpb25hbCkge1xuICAgICAgICBpZiAoIXRva2VuLnBhcnRpYWwpIHtcbiAgICAgICAgICBjYXB0dXJlID0gJyg/OicgKyBwcmVmaXggKyAnKCcgKyBjYXB0dXJlICsgJykpPydcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjYXB0dXJlID0gcHJlZml4ICsgJygnICsgY2FwdHVyZSArICcpPydcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2FwdHVyZSA9IHByZWZpeCArICcoJyArIGNhcHR1cmUgKyAnKSdcbiAgICAgIH1cblxuICAgICAgcm91dGUgKz0gY2FwdHVyZVxuICAgIH1cbiAgfVxuXG4gIC8vIEluIG5vbi1zdHJpY3QgbW9kZSB3ZSBhbGxvdyBhIHNsYXNoIGF0IHRoZSBlbmQgb2YgbWF0Y2guIElmIHRoZSBwYXRoIHRvXG4gIC8vIG1hdGNoIGFscmVhZHkgZW5kcyB3aXRoIGEgc2xhc2gsIHdlIHJlbW92ZSBpdCBmb3IgY29uc2lzdGVuY3kuIFRoZSBzbGFzaFxuICAvLyBpcyB2YWxpZCBhdCB0aGUgZW5kIG9mIGEgcGF0aCBtYXRjaCwgbm90IGluIHRoZSBtaWRkbGUuIFRoaXMgaXMgaW1wb3J0YW50XG4gIC8vIGluIG5vbi1lbmRpbmcgbW9kZSwgd2hlcmUgXCIvdGVzdC9cIiBzaG91bGRuJ3QgbWF0Y2ggXCIvdGVzdC8vcm91dGVcIi5cbiAgaWYgKCFzdHJpY3QpIHtcbiAgICByb3V0ZSA9IChlbmRzV2l0aFNsYXNoID8gcm91dGUuc2xpY2UoMCwgLTIpIDogcm91dGUpICsgJyg/OlxcXFwvKD89JCkpPydcbiAgfVxuXG4gIGlmIChlbmQpIHtcbiAgICByb3V0ZSArPSAnJCdcbiAgfSBlbHNlIHtcbiAgICAvLyBJbiBub24tZW5kaW5nIG1vZGUsIHdlIG5lZWQgdGhlIGNhcHR1cmluZyBncm91cHMgdG8gbWF0Y2ggYXMgbXVjaCBhc1xuICAgIC8vIHBvc3NpYmxlIGJ5IHVzaW5nIGEgcG9zaXRpdmUgbG9va2FoZWFkIHRvIHRoZSBlbmQgb3IgbmV4dCBwYXRoIHNlZ21lbnQuXG4gICAgcm91dGUgKz0gc3RyaWN0ICYmIGVuZHNXaXRoU2xhc2ggPyAnJyA6ICcoPz1cXFxcL3wkKSdcbiAgfVxuXG4gIHJldHVybiBuZXcgUmVnRXhwKCdeJyArIHJvdXRlLCBmbGFncyhvcHRpb25zKSlcbn1cblxuLyoqXG4gKiBOb3JtYWxpemUgdGhlIGdpdmVuIHBhdGggc3RyaW5nLCByZXR1cm5pbmcgYSByZWd1bGFyIGV4cHJlc3Npb24uXG4gKlxuICogQW4gZW1wdHkgYXJyYXkgY2FuIGJlIHBhc3NlZCBpbiBmb3IgdGhlIGtleXMsIHdoaWNoIHdpbGwgaG9sZCB0aGVcbiAqIHBsYWNlaG9sZGVyIGtleSBkZXNjcmlwdGlvbnMuIEZvciBleGFtcGxlLCB1c2luZyBgL3VzZXIvOmlkYCwgYGtleXNgIHdpbGxcbiAqIGNvbnRhaW4gYFt7IG5hbWU6ICdpZCcsIGRlbGltaXRlcjogJy8nLCBvcHRpb25hbDogZmFsc2UsIHJlcGVhdDogZmFsc2UgfV1gLlxuICpcbiAqIEBwYXJhbSAgeyhzdHJpbmd8UmVnRXhwfEFycmF5KX0gcGF0aFxuICogQHBhcmFtICB7KEFycmF5fE9iamVjdCk9fSAgICAgICBrZXlzXG4gKiBAcGFyYW0gIHtPYmplY3Q9fSAgICAgICAgICAgICAgIG9wdGlvbnNcbiAqIEByZXR1cm4geyFSZWdFeHB9XG4gKi9cbmZ1bmN0aW9uIHBhdGhUb1JlZ2V4cCAocGF0aCwga2V5cywgb3B0aW9ucykge1xuICBrZXlzID0ga2V5cyB8fCBbXVxuXG4gIGlmICghaXNhcnJheShrZXlzKSkge1xuICAgIG9wdGlvbnMgPSAvKiogQHR5cGUgeyFPYmplY3R9ICovIChrZXlzKVxuICAgIGtleXMgPSBbXVxuICB9IGVsc2UgaWYgKCFvcHRpb25zKSB7XG4gICAgb3B0aW9ucyA9IHt9XG4gIH1cblxuICBpZiAocGF0aCBpbnN0YW5jZW9mIFJlZ0V4cCkge1xuICAgIHJldHVybiByZWdleHBUb1JlZ2V4cChwYXRoLCAvKiogQHR5cGUgeyFBcnJheX0gKi8gKGtleXMpKVxuICB9XG5cbiAgaWYgKGlzYXJyYXkocGF0aCkpIHtcbiAgICByZXR1cm4gYXJyYXlUb1JlZ2V4cCgvKiogQHR5cGUgeyFBcnJheX0gKi8gKHBhdGgpLCAvKiogQHR5cGUgeyFBcnJheX0gKi8gKGtleXMpLCBvcHRpb25zKVxuICB9XG5cbiAgcmV0dXJuIHN0cmluZ1RvUmVnZXhwKC8qKiBAdHlwZSB7c3RyaW5nfSAqLyAocGF0aCksIC8qKiBAdHlwZSB7IUFycmF5fSAqLyAoa2V5cyksIG9wdGlvbnMpXG59XG4iLCJtb2R1bGUuZXhwb3J0cyA9IEFycmF5LmlzQXJyYXkgfHwgZnVuY3Rpb24gKGFycikge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKGFycikgPT0gJ1tvYmplY3QgQXJyYXldJztcbn07XG4iLCIvKipcbiAqIENvcHlyaWdodCAyMDE1IEdvb2dsZSBJbmMuIEFsbCByaWdodHMgcmVzZXJ2ZWQuXG4gKlxuICogTGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcbiAqIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cbiAqIFlvdSBtYXkgb2J0YWluIGEgY29weSBvZiB0aGUgTGljZW5zZSBhdFxuICpcbiAqICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcbiAqXG4gKiBVbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG4gKiBkaXN0cmlidXRlZCB1bmRlciB0aGUgTGljZW5zZSBpcyBkaXN0cmlidXRlZCBvbiBhbiBcIkFTIElTXCIgQkFTSVMsXG4gKiBXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cbiAqIFNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcbiAqIGxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLlxuICpcbiAqL1xuXG4oZnVuY3Rpb24oKSB7XG4gIHZhciBuYXRpdmVBZGRBbGwgPSBDYWNoZS5wcm90b3R5cGUuYWRkQWxsO1xuICB2YXIgdXNlckFnZW50ID0gbmF2aWdhdG9yLnVzZXJBZ2VudC5tYXRjaCgvKEZpcmVmb3h8Q2hyb21lKVxcLyhcXGQrXFwuKS8pO1xuXG4gIC8vIEhhcyBuaWNlIGJlaGF2aW9yIG9mIGB2YXJgIHdoaWNoIGV2ZXJ5b25lIGhhdGVzXG4gIGlmICh1c2VyQWdlbnQpIHtcbiAgICB2YXIgYWdlbnQgPSB1c2VyQWdlbnRbMV07XG4gICAgdmFyIHZlcnNpb24gPSBwYXJzZUludCh1c2VyQWdlbnRbMl0pO1xuICB9XG5cbiAgaWYgKFxuICAgIG5hdGl2ZUFkZEFsbCAmJiAoIXVzZXJBZ2VudCB8fFxuICAgICAgKGFnZW50ID09PSAnRmlyZWZveCcgJiYgdmVyc2lvbiA+PSA0NikgfHxcbiAgICAgIChhZ2VudCA9PT0gJ0Nocm9tZScgICYmIHZlcnNpb24gPj0gNTApXG4gICAgKVxuICApIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBDYWNoZS5wcm90b3R5cGUuYWRkQWxsID0gZnVuY3Rpb24gYWRkQWxsKHJlcXVlc3RzKSB7XG4gICAgdmFyIGNhY2hlID0gdGhpcztcblxuICAgIC8vIFNpbmNlIERPTUV4Y2VwdGlvbnMgYXJlIG5vdCBjb25zdHJ1Y3RhYmxlOlxuICAgIGZ1bmN0aW9uIE5ldHdvcmtFcnJvcihtZXNzYWdlKSB7XG4gICAgICB0aGlzLm5hbWUgPSAnTmV0d29ya0Vycm9yJztcbiAgICAgIHRoaXMuY29kZSA9IDE5O1xuICAgICAgdGhpcy5tZXNzYWdlID0gbWVzc2FnZTtcbiAgICB9XG5cbiAgICBOZXR3b3JrRXJyb3IucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShFcnJvci5wcm90b3R5cGUpO1xuXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA8IDEpIHRocm93IG5ldyBUeXBlRXJyb3IoKTtcblxuICAgICAgLy8gU2ltdWxhdGUgc2VxdWVuY2U8KFJlcXVlc3Qgb3IgVVNWU3RyaW5nKT4gYmluZGluZzpcbiAgICAgIHZhciBzZXF1ZW5jZSA9IFtdO1xuXG4gICAgICByZXF1ZXN0cyA9IHJlcXVlc3RzLm1hcChmdW5jdGlvbihyZXF1ZXN0KSB7XG4gICAgICAgIGlmIChyZXF1ZXN0IGluc3RhbmNlb2YgUmVxdWVzdCkge1xuICAgICAgICAgIHJldHVybiByZXF1ZXN0O1xuICAgICAgICB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgIHJldHVybiBTdHJpbmcocmVxdWVzdCk7IC8vIG1heSB0aHJvdyBUeXBlRXJyb3JcbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChcbiAgICAgICAgcmVxdWVzdHMubWFwKGZ1bmN0aW9uKHJlcXVlc3QpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIHJlcXVlc3QgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICByZXF1ZXN0ID0gbmV3IFJlcXVlc3QocmVxdWVzdCk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgdmFyIHNjaGVtZSA9IG5ldyBVUkwocmVxdWVzdC51cmwpLnByb3RvY29sO1xuXG4gICAgICAgICAgaWYgKHNjaGVtZSAhPT0gJ2h0dHA6JyAmJiBzY2hlbWUgIT09ICdodHRwczonKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgTmV0d29ya0Vycm9yKFwiSW52YWxpZCBzY2hlbWVcIik7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIGZldGNoKHJlcXVlc3QuY2xvbmUoKSk7XG4gICAgICAgIH0pXG4gICAgICApO1xuICAgIH0pLnRoZW4oZnVuY3Rpb24ocmVzcG9uc2VzKSB7XG4gICAgICAvLyBJZiBzb21lIG9mIHRoZSByZXNwb25zZXMgaGFzIG5vdCBPSy1laXNoIHN0YXR1cyxcbiAgICAgIC8vIHRoZW4gd2hvbGUgb3BlcmF0aW9uIHNob3VsZCByZWplY3RcbiAgICAgIGlmIChyZXNwb25zZXMuc29tZShmdW5jdGlvbihyZXNwb25zZSkge1xuICAgICAgICByZXR1cm4gIXJlc3BvbnNlLm9rO1xuICAgICAgfSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IE5ldHdvcmtFcnJvcignSW5jb3JyZWN0IHJlc3BvbnNlIHN0YXR1cycpO1xuICAgICAgfVxuXG4gICAgICAvLyBUT0RPOiBjaGVjayB0aGF0IHJlcXVlc3RzIGRvbid0IG92ZXJ3cml0ZSBvbmUgYW5vdGhlclxuICAgICAgLy8gKGRvbid0IHRoaW5rIHRoaXMgaXMgcG9zc2libGUgdG8gcG9seWZpbGwgZHVlIHRvIG9wYXF1ZSByZXNwb25zZXMpXG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgIHJlc3BvbnNlcy5tYXAoZnVuY3Rpb24ocmVzcG9uc2UsIGkpIHtcbiAgICAgICAgICByZXR1cm4gY2FjaGUucHV0KHJlcXVlc3RzW2ldLCByZXNwb25zZSk7XG4gICAgICAgIH0pXG4gICAgICApO1xuICAgIH0pLnRoZW4oZnVuY3Rpb24oKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH0pO1xuICB9O1xuXG4gIENhY2hlLnByb3RvdHlwZS5hZGQgPSBmdW5jdGlvbiBhZGQocmVxdWVzdCkge1xuICAgIHJldHVybiB0aGlzLmFkZEFsbChbcmVxdWVzdF0pO1xuICB9O1xufSgpKTsiXX0=
