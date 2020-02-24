/**
 *
 * UniFi ioBroker Adapter
 *
 * Adapter to communicate with a UniFi-Controller instance
 * dealing with UniFi-WiFi-Devices
 *
 */

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

let queryTimeout;
let setStateArray = [];

// Load your modules here, e.g.:
// const fs = require("fs");

class Unifi extends utils.Adapter {

    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'unifi'
        });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        this.getForeignObject('system.adapter.' + this.namespace, function (err, obj) {
            if (!err && obj && (obj.common.mode !== 'daemon')) {
                obj.common.mode = 'daemon';
                if (obj.common.schedule) {
                    delete(obj.common.schedule);
                }
                this.setForeignObject(obj._id, obj);
            }
        });

        // in this template all states changes inside the adapters namespace are subscribed
        this.subscribeStates('*');

        this.updateUniFiData();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            if (queryTimeout) {
                clearTimeout(queryTimeout);
            }
            this.log.info('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.message" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    onMessage(obj) {
        if (typeof obj === 'object' && obj.message) {
            if (obj.command === 'notify') {
                // e.g. send email or pushover or whatever
                this.log.info('got notify');

                if (queryTimeout) {
                    clearTimeout(queryTimeout);
                }
            }

        }
        this.updateUniFiData();
    }

    updateUniFiData() {

        this.log.info('Starting UniFi-Controller query');

        const update_interval = parseInt(this.config.update_interval, 10) || 60;
        const controller_ip = this.config.controller_ip || "127.0.0.1";
        const controller_port = this.config.controller_port || 8443;
        const controller_username = this.config.controller_username || "admin";
        const controller_password = this.config.controller_password || "";

        this.log.info('update_interval = ' + update_interval);
        this.log.info('controller = ' + controller_ip + ':' + controller_port);

        // get unifi class
        const unifi = require('node-unifi');

        const controller = new unifi.Controller(controller_ip, controller_port);

        //////////////////////////////
        // LOGIN
        controller.login(controller_username, controller_password, function (err) {

            if (err)
            {
                this.log.info('ERROR: ' + err);
                return;
            }

            //////////////////////////////
            // GET SITE STATS
            controller.getSitesStats(function (err, site_data) {
                var sites = site_data.map(function (s) {
                    return s.name;
                });

                this.log.info('getSitesStats: ' + sites);
                //adapter.log.info(JSON.stringify(site_data));

                this.processSiteInfo(site_data);

                //////////////////////////////
                // GET SITE SYSINFO
                controller.getSiteSysinfo(sites, function (err, sysinfo) {
                    this.log.info('getSiteSysinfo: ' + sysinfo.length);
                    //adapter.log.info(JSON.stringify(sysinfo));

                    this.processSiteSysInfo(sites, sysinfo);

                    //////////////////////////////
                    // GET CLIENT DEVICES
                    controller.getClientDevices(sites, function (err, client_data) {
                        this.log.info('getClientDevices: ' + client_data[0].length);
                        //adapter.log.info(JSON.stringify(client_data));

                        this.processClientDeviceInfo(sites, client_data);

                        //////////////////////////////
                        // GET ACCESS DEVICES
                        controller.getAccessDevices(sites, function (err, devices_data) {
                            this.log.info('getAccessDevices: ' + devices_data[0].length);
                            //adapter.log.info(JSON.stringify(devices_data));

                            this.processAccessDeviceInfo(sites, devices_data);

                            //////////////////////////////
                            // FINALIZE

                            // finalize, logout and finish
                            controller.logout();

                            // process all schedule state changes
                            this.processStateChanges(setStateArray);

                            // schedule a new execution of this.updateUniFiData in X seconds
                            queryTimeout = setTimeout(this.updateUniFiData, update_interval * 1000);
                        });
                    });
                });
            });
        });

        //var endpoints = [ unifi_login(controller_username, controller_password),
        //                  unifi_stat_sites(getSites),
        //                  //unifi_stat_sysinfo(sites, getSiteSysinfo),
        //                  //unifi_list_stations(site),
        //                  unifi_logout() ]

        //processRequests(endpoints);

        //queryTimeout = setTimeout(this.updateUniFiData, update_interval * 1000);
    }

    /**
     * Function to organize setState() calls that we are first checking if
     * the value is really changed and only then actually call setState()
     * to let others listen for changes
     */
    processStateChanges(stateArray, callback) {
        if (!stateArray || stateArray.length === 0)
        {
            if (typeof (callback) === 'function')
                callback();

            // clear the array
            setStateArray = [];
        } else
        {
            var newState = setStateArray.shift();
            this.getState(newState.name, function (err, oldState) {
                if (oldState === null || newState.val != oldState.val)
                {
                    //adapter.log.info('changing state ' + newState.name + ' : ' + newState.val);
                    this.setState(newState.name, {ack: true, val: newState.val}, function () {
                        setTimeout(this.processStateChanges, 0, setStateArray, callback);
                    });
                } else
                    setTimeout(this.processStateChanges, 0, setStateArray, callback);
            });
        }
    }

    /**
     * Function to create a state and set its value
     * only if it hasn't been set to this value before
     */
    async createState(name, value, desc) {

        if (typeof (desc) === 'undefined')
            desc = name;

        if (Array.isArray(value))
            value = value.toString();

        this.setObjectNotExists(name, {
            type: 'state',
            common: {name: desc,
                type: typeof (value),
                read: true,
                write: false },
            native: {id: name}
        });

        if (typeof (value) !== 'undefined') {
            setStateArray.push({name: name, val: value});
        }
    }

    /**
     * Function to create a channel
     */
    async createChannel(name, desc) {

        if (typeof (desc) === 'undefined') {
            desc = name;
        }

        this.setObjectNotExists(name, {
            type: 'channel',
            common: {name: desc},
            native: {}
        });
    }

    /**
     * Function that receives the site info as a JSON data array
     * and parses through it to create all channels+states
     */
    async processSiteInfo(site_data) {

        // lets store some site information
        for (var i = 0; i < site_data.length; i++)
        {
            // traverse the json with depth 0..2 only
            traverse(site_data[i], site_data[i].name, 0, 2, function (name, value, depth)
            {
                //adapter.log.info('(' + depth + '): ' + name + ' = ' + value + ' type: ' + typeof(value));

                if (typeof (value) === 'object')
                {
                    if (depth == 1)
                        this.createChannel(name, 'Site ' + value.desc);
                    else // depth == 2
                    {
                        // continue the traversal of the object with depth 2
                        traverse(value, name, 2, 2, function (name, value, depth)
                        {
                            //adapter.log.info('_(' + depth + '): ' + name + ' = ' + value + ' type: ' + typeof(value));
                            this.createChannel(name);

                            // walk through all sub values on a flat level starting with the
                            // subsystem tree.
                            traverse(value, name + '.' + value.subsystem, 0, 0, function (name, value, depth)
                            {
                                //adapter.log.info('__(' + depth + '): ' + name + ' = ' + value + ' type: ' + typeof(value));
                                if (typeof (value) === 'object')
                                    this.createChannel(name, 'Subsystem ' + value.subsystem);
                                else
                                    this.createState(name, value);
                            });
                        });
                    }
                } else
                    this.createState(name, value);
            });
        }
    }

    /**
     * Function that receives the client device info as a JSON data array
     * and parses through it to create all channels+states
     */
    async processClientDeviceInfo(sites, clientDevices) {

        // lets store some site information
        for (var i = 0; i < sites.length; i++)
        {
            // traverse the json with depth 3..4 only
            traverse(clientDevices[i], sites[i] + '.clients', 2, 2, function (name, value, depth)
            {
                //adapter.log.info('(' + depth + '): ' + name + ' = ' + value + ' type: ' + typeof(value));

                if (typeof (value) === 'object')
                {
                    // continue the traversal of the object with depth 2
                    traverse(value, name + '.' + value.mac, 1, 0, function (name, value, depth)
                    {
                        //adapter.log.info('_(' + depth + '): ' + name + ' = ' + value + ' type: ' + typeof(value));

                        if (depth == 1)
                            this.createChannel(name, typeof (value.hostname) !== 'undefined' ? value.hostname : '');
                        else
                            this.createState(name, value);
                    });
                } else {
                    this.createState(name, value);
                }
            });
        }
    }

    /**
     * Function that receives the access device info as a JSON data array
     * and parses through it to create all channels+states
     */
    async processAccessDeviceInfo(sites, accessDevices) {

        // lets store some site information
        for (var i = 0; i < sites.length; i++)
        {
            // traverse the json with depth 3..4 only
            traverse(accessDevices[i], sites[i] + '.devices', 2, 2, function (name, value, depth)
            {
                //adapter.log.info('(' + depth + '): ' + name + ' = ' + value + ' type: ' + typeof(value));

                if (typeof (value) === 'object' && value !== null)
                {
                    // continue the traversal of the object with depth 2
                    traverse(value, name + '.' + value.mac, 1, 2, function (name, value, depth)
                    {
                        //adapter.log.info('_(' + depth + '): ' + name + ' = ' + value + ' type: ' + typeof(value));

                        if (depth === 1) {
                            this.createChannel(name, value.model + ' - ' + value.serial);
                        } else if (typeof (value) === 'object' && value !== null) {
                            traverse(value, name, 1, 2, function (name, value, depth)
                            {
                                //adapter.log.info('__(' + depth + '): ' + name + ' = ' + value + ' type: ' + typeof(value) + ' is_null: ' + (value === null));

                                if (depth === 1) {
                                    this.createChannel(name, name);
                                } else if (typeof (value) === 'object' && value !== null) {
                                    traverse(value, name + '.' + value.name, 1, 0, function (name, value, depth) {
                                        //adapter.log.info('___(' + depth + '): ' + name + ' = ' + value + ' type: ' + typeof(value));

                                        if (depth === 1)
                                            this.createChannel(name, name);
                                        else
                                            this.createState(name, value);
                                    });
                                } else {
                                    this.createState(name, value);
                                }
                            });
                        } else {
                            this.createState(name, value);
                        }
                    });
                } else {
                    this.createState(name, value);
                }
            });
        }
    }

    /**
     * Function that receives the site sysinfo as a JSON data array
     * and parses through it to create all channels+states
     */
    async processSiteSysInfo(sites, sysinfo) {

        // lets store some site information
        for (var i = 0; i < sysinfo.length; i++)
        {
            // traverse the json with depth 0..2 only
            traverse(sysinfo[i], sites[i] + '.sysinfo', 2, 4, function (name, value, depth)
            {
                //adapter.log.info('(' + depth + '): ' + name + ' = ' + value + ' type: ' + typeof(value) + ' array: ' + Array.isArray(value));

                if (typeof (value) === 'object')
                {
                    if (depth == 2) {
                        this.createChannel(name, 'Site Sysinfo');
                    } else if (depth == 3) {
                        this.createChannel(name);
                    } else {
                        if (typeof (value.key) !== 'undefined')
                        {
                            // continue the traversal of the object with depth 2
                            traverse(value, name + '.' + value.key, 1, 2, function (name, value, depth)
                            {
                                //adapter.log.info('_(' + depth + '): ' + name + ' = ' + value + ' type2: ' + typeof(value) + ' array: ' + Array.isArray(value));

                                if (Array.isArray(value) === false && typeof (value) === 'object') {
                                    this.createChannel(name, value.name);
                                } else {
                                    this.createState(name, value);
                                }
                            });
                        } else {
                            this.createState(name, value);
                        }
                    }
                } else {
                    this.createState(name, value);
                }
            });
        }
    }
}

/**
 * Helper functions to parse our JSON-based result data in
 * a recursive/traversal fashion.
 */
function traverse(x, level, mindepth, maxdepth, cb, depth) {
    if (typeof (depth) === 'undefined') {
        depth = 0;
    }

    depth++;
    if (typeof (maxdepth) !== 'undefined' && maxdepth !== 0 && depth > maxdepth) {
        return;
    }

    if (Array.isArray(x)) {
        traverseArray(x, level, mindepth, maxdepth, cb, depth);
    } else if ((typeof (x) === 'object') && (x !== null)) {
        traverseObject(x, level, mindepth, maxdepth, cb, depth);
    } else if (mindepth <= depth && cb(level, x, depth) === false) {
        return;
    }
}

function traverseArray(arr, level, mindepth, maxdepth, cb, depth) {
    if (mindepth <= depth && cb(level, arr, depth) === false) {
        return;
    }

    arr.every(function (x, i) {
        if ((typeof (x) === 'object')) {
            traverse(x, level, mindepth, maxdepth, cb, depth);
        } else {
            return false;
        }

        return true;
    });
}

function traverseObject(obj, level, mindepth, maxdepth, cb, depth) {
    if (mindepth <= depth && cb(level, obj, depth) === false) {
        return;
    }

    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            traverse(obj[key], level + '.' + key, mindepth, maxdepth, cb, depth);
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Unifi(options);
} else {
    // otherwise start the instance directly
    new Unifi();
}
