RPS._observers = {};

RPS.observeChanges = function (collection, options, callbacks) {
    //console.log('RPS.observeChanges');
    var listenerId = Random.id(),
        collectionName = collection._name,
        cursorDescription = {
            collectionName: collectionName,
            options: _.extend(options || {}, {selector: Mongo.Collection._rewriteSelector(options.selector || {})})
        },
        observerKey = JSON.stringify(cursorDescription),
        observer = RPS._observers[observerKey] || (RPS._observers[observerKey] = new RPS._observer(collection, options, observerKey));

    // initial fetch, if needed or take it from cache (pause incoming messages, while initial add)
    observer.addListener(listenerId, callbacks);

    // return stop method
    return {
        stop: function () {
            observer.removeListener(listenerId);
        },
        docs: observer.docs
    }
};

RPS._observer = function (collection, options, key) {
    //console.log('RPS._observer');

    this.collection = collection;
    this.options = options;
    this.selector = options.selector;
    this.findOptions = options.options || {};
    this.findOptions.fields = this.findOptions.fields || {};
    this.needToFetchAlways = this.findOptions.limit || this.findOptions.sort;
    this.quickFindOptions = _.extend({}, this.findOptions, {fields: {_id: 1}});

    this.projectionFields = _.clone(this.findOptions.fields);
    _.each(this.options.docsMixin, function (value, key) {
        this.projectionFields[key] = 1;
    }, this);

    this.projectionFn = LocalCollection._compileProjection(this.projectionFields);

    this.channel = options.channel || collection._name;
    this.key = key;
    this.listeners = {};
    this.docs = {};
    this.messageQueue = [];

    // You may not filter out _id when observing changes, because the id is a core
    // part of the observeChanges API
    if (this.findOptions.fields._id === 0 ||
        this.findOptions.fields._id === false) {
        throw Error("You may not observe a cursor with {fields: {_id: 0}}");
    }

    this.initialize();
};

// initialize, subscribe to channel
RPS._observer.prototype.initialize = function () {
    if (this.initialized) return;
    //console.log('RPS._observer.initialize');

    RPS._messenger.addObserver(this.key, this.channel);

    this.initialized = true;
};

RPS._observer.prototype.addListener = function (listenerId, callbacks) {
    if (_.isEmpty(callbacks)) return;
    //console.log('RPS._observer.addListener; listenerId:', listenerId);
    this.listeners[listenerId] = callbacks;
    this.pause();
    this.initialFetch();
    this.initialAdd(listenerId);
    this.resume();
};

RPS._observer.prototype.callListeners = function (action, id, fields) {
    //console.log('RPS._observer.callListeners');
    _.each(this.listeners, function (callbacks, listenerId) {
        //console.log('RPS._observer.callListeners; listenerId, action, id, fields:', listenerId, action, id, fields);
        callbacks[action](id, fields);
    }, this);
};

RPS._observer.prototype.removeListener = function (listenerId) {
    //console.log('RPS._observer.removeListener; listenerId:', listenerId);
    delete this.listeners[listenerId];
    if (_.isEmpty(this.listeners)) {
        this.kill();
    }
};

RPS._observer.prototype.initialFetch = function () {
    if (this.initiallyFetched) return;
    //console.log('RPS._observer.initialFetch');

    var docs = this.collection.find(this.selector, this.findOptions).fetch();

    _.each(docs, function (doc) {
        this.docs[doc._id] = doc;
    }, this);

    this.initiallyFetched = true;
};

RPS._observer.prototype.initialAdd = function (listenerId) {
    //console.log('RPS._observer.initialAdd; listenerId:', listenerId);

    var callbacks = this.listeners[listenerId];

    _.each(this.docs, function (doc, id) {
        callbacks.added(id, _.extend(doc, this.options.docsMixin));
    }, this);
};

RPS._observer.prototype.onMessage = function (message) {
    if (!this.initiallyFetched) return;
    //console.log('RPS._observer.onMessage; message:', message);

    if (this.paused) {
        this.messageQueue.push(message);
    } else {
        this.handleMessage(message);
    }
};

RPS._observer.prototype.handleMessage = function (message) {
    //this.pause();
    console.log('RPS._observer.handleMessage; message, this.selector:', message, this.selector);
    var rightIds = this.needToFetchAlways && _.pluck(this.collection.find(this.selector, this.quickFindOptions).fetch(), '_id'),
        ids = !message.id || _.isArray(message.id) ? message.id : [message.id];

    //console.log('RPS._observer.handleMessage; message.withoutMongo, ids:', message.withoutMongo, ids);
    if (message.withoutMongo && !ids) {
        //console.log('RPS._observer.handleMessage; this.docs, message.selector:', this.docs, message.selector);
        ids = _.pluck(_.where(_.values(this.docs), message.selector), '_id');
        //console.log('RPS._observer.handleMessage; ids:', ids);
    }

    if (!ids || !ids.length) return;

    _.each(ids, function (id) {
        var oldDoc = this.docs[id],
            knownId = !!oldDoc,
            isSimpleModifier = RPS._isSimpleModifier(message.modifier),
            isRightId = !rightIds || _.contains(rightIds, id),
            newDoc;

        //console.log('RPS._observer.handleMessage; oldDoc, this.selector:', oldDoc, this.selector);

        if (message.method === 'insert') {
            newDoc = _.extend(message.selector, {_id: id});
        } else if (message.withoutMongo && message.method !== 'remove') {
            newDoc = RPS._modifyDoc(_.extend(oldDoc || {_id: id}), message.modifier);
        }

        //console.log('RPS._observer.handleMessage; newDoc:', newDoc);

        var needToFetch = !newDoc && (!knownId || !isSimpleModifier) && isRightId && message.method !== 'remove';

        if (needToFetch) {
            newDoc = this.collection.findOne({_id: id}, this.findOptions);
        } else if (!newDoc && oldDoc && _.contains(['update', 'upsert'], message.method)) {
            newDoc = RPS._modifyDoc(oldDoc, message.modifier);
        }

        var dokIsOk = newDoc && isRightId && (message.withoutMongo || needToFetch || _.contains(rightIds, id) || this.collection.find(_.extend({}, this.selector, {_id: id}), this.quickFindOptions).count());

        //console.log('RPS._observer.handleMessage; newDoc, this.selector:', newDoc, this.selector);
        //console.log('RPS._observer.handleMessage; dokIsOk, this.selector:', dokIsOk, this.selector);
        //console.log('RPS._observer.handleMessage; _.isEqual(newDoc, oldDoc), this.selector:', _.isEqual(newDoc, oldDoc), this.selector);

        if (message.method !== 'remove' && dokIsOk) {
            // added or changed
            var action, fields;

            if (knownId) {
                action = 'changed';
                fields = DiffSequence.makeChangedFields(newDoc, oldDoc);
            } else {
                action = 'added';
                fields = _.extend(newDoc, this.options.docsMixin);
            }

            //console.log('RPS._observer.handleMessage; fields, this.projectionFn(fields), this.selector:', fields, this.projectionFn(fields), this.selector);

            // todo: filter fields for changes
            this.callListeners(action, id, this.projectionFn(fields));

            this.docs[id] = newDoc;
        } else if (knownId) {
            // removed
            this.callListeners('removed', id);
            delete this.docs[id];
        }

        if (rightIds) {
            // remove irrelevant docs
            var idMap = _.keys(this.docs);
            _.each(_.difference(idMap, rightIds), function (id) {
                this.callListeners('removed', id);
                delete this.docs[id];
            }, this);

            // add new from DB
            _.each(_.difference(rightIds, idMap), function (id) {
                var doc = this.collection.findOne({_id: id}, this.findOptions);
                this.callListeners('added', id, doc);
                this.docs[id] = doc;
            }, this);
        }
    }, this);

    //this.resume();
};

RPS._observer.prototype.pause = function () {
    //console.log('RPS._observer.pause');
    this.paused = true;
};

RPS._observer.prototype.resume = function () {
    //console.log('RPS._observer.resume');
    while (this.messageQueue.length) {
        this.handleMessage(this.messageQueue.shift());
    }
    this.paused = false;
};

// kill, unsubscribe
RPS._observer.prototype.kill = function () {
    if (!this.initialized) return;
    //console.log('RPS._observer.kill');

    RPS._messenger.removeObserver(this.key);
    delete RPS._observers[this.key];

    this.initialized = false;
};