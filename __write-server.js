RPS.write = function (collection, method, options) {
    var collectionName = collection._name,
        config = RPS.config[collectionName] || {},
        channels, idMap, docs, fields,
        ts = Date.now();

    //console.log('RPS.write; collectionName, method, options, config:', collectionName, method, options, config);

    var publish = function (res) {
        //console.log('RPS.write → publish; channels:', channels);
        if (channels) {
            //console.log('RPS.write → ready to notify Redis; res:', res);

            var id = idMap || options.selector._id;

            if (!id || !id.length) {
                id = method === 'insert' ? res : method === 'upsert' && res.insertedId;
            }

            var message = {
                    _serverId: RPS._serverId,
                    selector: options.selector,
                    modifier: options.redModifier || options.modifier,
                    method: method,
                    withoutMongo: options.withoutMongo,
                    ts: ts,
                    id: id
                },
                messageString = JSON.stringify(message);

            _.each(_.isArray(channels) ? channels : [channels], function (channel) {
                //console.log('RPS.write → publish to Redis; channel, message:', channel, messageString);
                if (channel) {
                    RPS._messenger.onMessage(channel, message);

                    ////Meteor.setTimeout(function () {
                        RPS._pub(channel, messageString);
                    ////}, _.random(0, 1000));  // simulate race condition
                }
            });
        }

        return res;
    };

    options = options || {};
    options.selector = options.selector ? Mongo.Collection._rewriteSelector(options.selector) : options.doc || {};
    options.fields = options.fields || {};

    channels = options.channels || config.channels || collectionName;
    var channelsIsFunction = _.isFunction(channels);
    var fetchFields = _.compact(_.union(options.fetchFields || config.fetchFields, ['_id']));
    if (channels && method !== 'insert') {
        var existedFields = _.union(_.keys(options.selector), _.keys(options.fields)),
            missedFields = _.difference(fetchFields, existedFields);

        //console.log('RPS.write; _.keys(options.fields), existedFields, missedFields:', _.keys(options.fields), existedFields, missedFields);

        if ((missedFields.length && channelsIsFunction) || !LocalCollection._selectorIsId(options.selector._id)) {
            var findOptions = {fields: {}};
            _.each(missedFields.length ? missedFields : ['_id'], function (fieldName) {
                findOptions.fields[fieldName] = 1;
            });

            //console.log('RPS.write → FETCH DOCS FROM DB; options.selector, fields:', options.selector, findOptions);
            docs = collection.find(options.selector, findOptions).fetch();
            idMap = _.pluck(docs, '_id');
            if (idMap.length === 1) {
                idMap = idMap[0];
            }
        }
    }

    _.each(fetchFields, function (field) {
        if (!fields) fields = {};

        var value = options.fields[field] || options.selector[field] || _.compact(_.uniq(_.pluck(docs, field)));

        if (_.isArray(value) && value.length === 1) {
            value = value[0];
        }

        fields[field] = value;
    });

    if (channelsIsFunction) {
        channels = channels(options.selector, fields);
    }

    var callback = _.last(_.toArray(arguments)),
        async = _.isFunction(callback);

    //console.log('RPS.write; channels, async:', channels, async);

    if (async && !options.withoutMongo && !options.noWrite) {
        //console.log('RPS.write → async && !options.withoutMongo');
        return RPS._write(collection, method, options, function (err, res) {
            if (!err) {
                publish(res);
            }
            callback(err, res);
        });
    } else {
        var res = !options.withoutMongo && !options.noWrite && RPS._write(collection, method, options);
        //console.log('RPS.write → before publish; res:', res);
        return publish(res);
    }
};