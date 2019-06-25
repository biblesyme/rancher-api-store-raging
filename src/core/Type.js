import Serializable from './Serializable'
import {normalizeType} from '../utils/normalize'
import { copyHeaders } from '../utils/apply-headers'
import urlOptions from '../utils/urlOptions'
import {get, set} from '../utils/util'
import {resolve, reject} from 'Promise'

class Type extends Serializable {
  static reopenClass(opt = {}) {
    Object.entries(opt).forEach(([k, v]) => {
      this[k] = v
    })
  }
  constructor(input = {}) {
    super()
    Object.entries(input).forEach(([key, value]) => {
      this[key] = value
    })
    this.schema = null
  }

  id = null
  type = null
  links = null

  toString() {
    return '(generic store type mixin)';
  }

  // unionArrays=true will append the new values to the existing ones instead of overwriting.
  merge(newData, unionArrays=false) {
    var self = this;

    newData.eachKeys(function(v, k) {
      if ( newData.hasOwnProperty(k) ) {
        var curVal = self[k];
        if ( unionArrays && Array.isArray(curVal) && Array.isArray(v) ) {
          curVal.addObjects(v);
        } else {
          self[k] = v;
        }
      }
    });

    return self;
  }

  replaceWith(newData) {
    var self = this;
    // Add/replace values that are in newData
    newData.eachKeys(function(v, k) {
      self[k] = v;
    });

    // Remove values that are in current but not new.
    var newKeys = newData.allKeys();
    this.eachKeys(function(v, k) {
      // If the key is a valid link name and
      if ( newKeys.indexOf(k) === -1 && !this.hasLink(k) ) {
        self[k] = undefined;
      }
    });

    return self;
  }

  clone() {
    let store = this.store;
    let output = store.createRecord(JSON.parse(JSON.stringify(this.serialize())), {updateStore: false});
    //output.set('store', get(this, 'store'));
    return output;
  }

  linkFor(name) {
    var url = get(this,'links.'+name);
    return url;
  }

  pageFor(which) {
    return get(this, `pagination.${which}`);
  }

  hasLink(name) {
    return !!this.linkFor(name);
  }

  headers = null
  request(opt) {
    if ( !opt.headers ) {
      opt.headers = {};
    }

    copyHeaders(this.constructor.headers, opt.headers);
    copyHeaders(get(this, 'headers'), opt.headers);

    return get(this, 'store').request(opt);
  }

  followPagination(which, opt) {
    var url = this.pageFor(which);

    if (!url) {
      throw new Error('Unknown link');
    }

    opt = opt || {};
    opt.url = url;
    opt.depaginate = false;

    return this.request(opt);
  }

  followLink(name, opt) {
    var url = this.linkFor(name);
    opt = opt || {};

    if (!url) {
      throw new Error('Unknown link');
    }

    opt.url = urlOptions(url, opt);

    return this.request(opt);
  }

  hasAction(name) {
    var url = get(this, 'actionLinks.'+name);
    return !!url;
  }

  computedHasAction(name) {
    return this.hasAction(name);
  }

  doAction(name, data, opt) {
    var url = get(this, 'actionLinks.'+name);
    if (!url) {
      return reject(new Error('Unknown action: ' + name));
    }

    opt = opt || {};
    opt.method = 'POST';
    opt.url = opt.url || url;
    if ( data ) {
      opt.data = data;
    }

    // Note: The response object may or may not be this same object, depending on what the action returns.
    return this.request(opt);
  }

  save(opt) {
    var self = this;
    var store = get(this, 'store');
    opt = opt || {};

    var id = get(this, 'id');
    var type = normalizeType(get(this, 'type'));
    if ( id ) {
      // Update
      opt.method = opt.method || 'PUT';
      opt.url = opt.url || this.linkFor('self');
    } else {
      // Create
      if ( !type ) {
        return reject(new Error('Cannot create record without a type'));
      }

      opt.method = opt.method || 'POST';
      opt.url = opt.url || type;
    }

    if ( opt.qp ) {
      for (var k in opt.qp ) {
        opt.url += (opt.url.indexOf('?') >= 0 ? '&' : '?') + encodeURIComponent(k) + '=' + encodeURIComponent(opt.qp[k]);
      }
    }

    var json = this.serialize();

    delete json['links'];
    delete json['actions'];
    delete json['actionLinks'];

    if ( typeof opt.data === 'undefined' ) {
      opt.data = json;
    }

    return this.request(opt).then(function(newData) {
      if ( !newData || !(newData instanceof Type)) {
        return newData;
      }

      var newId = newData.get('id');
      var newType = normalizeType(newData.get('type'));
      if ( !id && newId && type === newType ) {

        // A new record was created.  Typeify will have put it into the store,
        // but it's not the same instance as this object.  So we need to fix that.
        self.merge(newData);
        var existing = store.getById(type,newId);
        if ( existing ) {
          store._remove(type, existing);
        }
        store._add(type, self);

        // And also for the base type
        var baseType = self.get('baseType');
        if ( baseType ) {
          baseType = normalizeType(baseType);
          if ( baseType !== type ) {
            existing = store.getById(baseType,newId);
            if ( existing ) {
              store._remove(baseType, existing);
            }
            store._add(baseType, self);
          }
        }
      }

      return self;
    });
  }

  delete(opt) {
    var self = this;
    var store = get(this, 'store');
    var type = get(this, 'type');

    opt = opt || {};
    opt.method = 'DELETE';
    opt.url = opt.url || this.linkFor('self');

    return this.request(opt).then(function(newData) {
      if ( store.get('removeAfterDelete') || opt.forceRemove || opt.responseStatus === 204 ) {
        store._remove(type, self);
      }
      return newData;
    });
  }

  reload(opt) {
    if ( !this.hasLink('self') ) {
      return reject('Resource has no self link');
    }

    var url = this.linkFor('self');

    opt = opt || {};
    if ( typeof opt.method === 'undefined' ) {
      opt.method = 'GET';
    }

    if ( typeof opt.url === 'undefined' ) {
      opt.url = url;
    }

    var self = this;
    return this.request(opt).then(function(/*newData*/) {
      return self;
    });
  }

  isInStore() {
    var store = get(this, 'store');
    return store && get(this, 'id') && get(this, 'type') && store.hasRecord(this);
  }
}

export default Type
