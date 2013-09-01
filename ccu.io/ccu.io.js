/**
 *      CCU.IO
 *
 *      Socket.IO based HomeMatic Interface
 *
 *      Copyright (c) 2013 http://hobbyquaker.github.io
 *
 *      CC BY-NC 3.0
 *
 *      Kommerzielle Nutzung nicht gestattet!
 *
 */

var settings = require(__dirname+'/settings.js');

settings.version = "0.9.15";

var fs = require('fs'),
    logger =    require(__dirname+'/logger.js'),
    binrpc =    require(__dirname+"/binrpc.js"),
    rega =      require(__dirname+"/rega.js"),
    express =   require('express'),
    app = express(),
    url = require('url'),
    server =    require('http').createServer(app),
    socketio =  require('socket.io'),
    io,
    devlog,
    devlogCache = [],
    notFirstVarUpdate = false;

var socketlist = [],
    homematic = {},
    datapoints = {},
    regaObjects = {},
    regaIndex = {
        Name: {},
        Address: {}
    };

logger.info("ccu.io        starting version "+settings.version);
logger.info("              copyright (c) 2013 hobbyquaker");

var regahss = new rega({
    ccuIp: settings.ccuIp,
    ready: function() {

    }
});

if (settings.logging.enabled) {

    devlog = fs.createWriteStream(__dirname+"/log/"+settings.logging.file, {
        flags: "a", encoding: "utf8", mode: 0644
    });

    setInterval(writeLog, settings.logging.writeInterval * 1000);

    if (settings.logging.move) {
        var midnight = new Date();
        midnight.setHours( 23 );
        midnight.setMinutes( 59 );
        midnight.setSeconds( 59 );
        midnight.setMilliseconds( 950 );
        setTimeout(moveLog, midnight.getTime() - new Date().getTime());
    }
}

loadRegaData();

var stats = {
    clients: 0,
    cuxd: 0,
    wired: 0,
    rf: 0,
    start: ((new Date()).getTime()),
    uptime: function() {
        var mseconds = ((new Date()).getTime()) - stats.start;
        var diff = new Date(mseconds);
        var hours = diff.getHours();
        var days = Math.floor(hours/24);
        hours = hours - (24 * days);
        return days+" Tage, "+(hours-1)+" Stunden, "+ diff.getMinutes()+" Minuten, "+diff.getSeconds()+" Sekunden";
    },
    log: function() {
        logger.info("ccu.io stats  cuxd: "+(stats.cuxd/settings.statsIntervalMinutes).toFixed(0)+"msg/min, wired: "+(stats.wired/settings.statsIntervalMinutes).toFixed(0)+"msg/min, rf: "+(stats.rf/settings.statsIntervalMinutes).toFixed(0)+"msg/min");
        logger.info("ccu.io stats  "+socketlist.length+" Socket.IO Clients connected");
        logger.verbose("ccu.io uptime "+stats.uptime());
        stats.cuxd = 0;
        stats.wired = 0;
        stats.rf = 0;
    }
}

if (settings.stats) {
    setInterval(stats.log, settings.statsIntervalMinutes * 60000);
}

function sendEvent(arr) {
    logger.verbose("socket.io --> broadcast event "+JSON.stringify(arr))
    io.sockets.emit("event", arr);
}

function setDatapoint(id, val, ts, ack) {

    // unescape HomeMatic Script WriteURL()
    if (typeof val == "string") {
        val = unescape(val);
    }

    var oldval = datapoints[id];
    datapoints[id] = [val,ts,ack];

    if (!oldval) {
        // Neu
        logger.warn("rega      <-- unknown variable "+id);
        sendEvent([id,val,ts,ack]);
    } else if (val !== oldval[0]) {
        // Todo Änderungs-Zeitstempel -> Variablen extra behandeln
        // Änderung
        logger.debug("chg "+JSON.stringify(oldval)+" -> "+JSON.stringify([val,ts,ack]));
        sendEvent([id,val,ts,ack]);
    } else {
        if (ack && !oldval[2]) {
            // Bestätigung
            logger.debug("ack "+JSON.stringify(oldval)+" -> "+JSON.stringify([val,ts,ack]));
            sendEvent([id,val,ts,ack]);
        } else if (ts !== oldval[1]) {
            // Aktualisierung
            logger.debug("ts "+JSON.stringify(oldval)+" -> "+JSON.stringify([val,ts,ack]));
            sendEvent([id,val,ts,ack]);
        } else {
            // Keine Änderung
            logger.debug("eq "+JSON.stringify(oldval)+" -> "+JSON.stringify([val,ts,ack]));
        }

    }
}


function pollRega() {
    regahss.runScriptFile("polling", function (data) {
        var data = JSON.parse(data);
        var val;
        for (id in data) {
            if (settings.logging.enabled) {
                var ts = Math.round((new Date()).getTime() / 1000);
                if (typeof data[id][0] == "string") {
                    val = unescape(data[id][0]);
                } else {
                    val = data[id][0];
                }
                if (settings.logging.varChangeOnly && notFirstVarUpdate) {
                    if (datapoints[id][0] != val) {
                        cacheLog(ts+" "+id+" "+val+"\n");
                    }
                } else {
                    cacheLog(ts+" "+id+" "+val+"\n");
                }
            }
            setDatapoint(parseInt(id,10), data[id][0], data[id][1], true);
        }
        notFirstVarUpdate = true;
        setTimeout(pollRega, settings.regahss.pollDataInterval);
    });
}

function loadRegaData(index) {
    if (!index) { index = 0; }
    var type = settings.regahss.metaScripts[index];
    regahss.runScriptFile(type, function (data) {
        var data = JSON.parse(data);
        logger.verbose("ccu.io        indexing "+type);
        for (var id in data) {
            var idInt = parseInt(id, 10);

            // HomeMatic Script "WriteURL" dekodieren
            for (var key in data[id]) {
                // Nur Strings und auf keinen Fall Kanal- oder Datenpunkt-Arrays
                if (typeof data[id][key] == "string" && key !== "Channels" && key !== "DPs") {
                    data[id][key] = unescape(data[id][key]);
                }
            }

            // Index erzeugen
            var TypeName = data[id].TypeName;
            // Typen-Index (einfach ein Array der IDs)
            if (!regaIndex[TypeName]) {
                regaIndex[TypeName] = [];
            }
            regaIndex[TypeName].push(idInt);
            // Namens-Index
            regaIndex.Name[data[id].Name] = [idInt, TypeName, data[id].Parent];
            // ggf. Adressen-Index
            if (data[id].Address) {
                regaIndex.Address[data[id].Address] = [idInt, TypeName, data[id].Parent];
            }

            // ggf. Werte setzen
            if (type == "variables" || type == "datapoints") {
                datapoints[id] = [data[id].Value, data[id].Timestamp, true];
                // Werte aus data Objekt entfernen
                delete data[id].Value;
                delete data[id].Timestamp
            }

            // Meta-Daten setzen
            regaObjects[id] = data[id];

        }

        index += 1;
        if (index < settings.regahss.metaScripts.length) {
            loadRegaData(index);
        } else {
            settings.regaReady = true;
            logger.info("rega          data succesfully loaded");
            if (settings.regahss.pollData) {
                pollRega();
            }
            initRpc();
            initWebserver();

        }

    });

}

function initRpc() {
    homematic = new binrpc({
        ccuIp: settings.ccuIp,
        listenIp: settings.binrpc.listenIp,
        listenPort: settings.binrpc.listenPort,
        inits: settings.binrpc.inits,
        methods: {
            event: function (obj) {
                //Todo Implement Rega Polling Trigger via Virtual Key

                var ts = new Date();
                var timestamp = ts.getFullYear() + '-' +
                    ("0" + (ts.getMonth() + 1).toString(10)).slice(-2) + '-' +
                    ("0" + (ts.getDate()).toString(10)).slice(-2) + ' ' +
                    ("0" + (ts.getHours()).toString(10)).slice(-2) + ':' +
                    ("0" + (ts.getMinutes()).toString(10)).slice(-2) + ':' +
                    ("0" + (ts.getSeconds()).toString(10)).slice(-2);

                var bidcos;
                switch (obj[0]) {
                    case "io_cuxd":
                    case "CUxD":
                        stats.cuxd += 1;
                        bidcos = "CUxD." + obj[1] + "." + obj[2];
                        break;
                    case "io_rf":
                        stats.rf += 1;
                        bidcos = "BidCos-RF." + obj[1] + "." + obj[2];
                        break;
                    case "io_wired":
                        stats.wired += 1;
                        bidcos = "BidCos-Wired." + obj[1] + "." + obj[2];
                        break;
                    default:
                    //
                }

                // Get ReGa id
                var regaObj = regaIndex.Name[bidcos];

                if (regaObj && regaObj[0] && settings.logging.enabled) {
                    var ts = Math.round((new Date()).getTime() / 1000);
                    cacheLog(ts+" "+regaObj[0]+" "+obj[3]+"\n");
                }

                if (regaObj && regaObj[0]) {
                    logger.verbose("socket.io --> broadcast event "+JSON.stringify([regaObj[0], obj[3], timestamp, true]))
                    io.sockets.emit("event", [regaObj[0], obj[3], timestamp, true]);
                    datapoints[regaObj[0]] = [obj[3], timestamp, true];
                }

                /* TODO remove old event (DashUI 0.8.x compatibility)
                 var result = [];

                result = [bidcos, obj[3]];
                io.sockets.emit("event", result);
                */
                return "";
            }
        }
    });
}

function initWebserver() {
    app.use('/', express.static(__dirname + '/www'));
    server.listen(settings.ioListenPort);
    logger.info("webserver     listening on port "+settings.ioListenPort);

    // File Uploads
    app.use(express.bodyParser());
    app.post('/upload', function(req, res, next) {
        var urlParts = url.parse(req.url, true);
        var query = urlParts.query;

        //console.log(query);
        logger.verbose("webserver <-- file upload "+req.files.file.name+" ("+req.files.file.size+" bytes)");
        // get the temporary location of the file
        var tmpPath = req.files.file.path;
        var newName;
        if (query.id) {
            newName = query.id + "." + req.files.file.type.replace(/[a-z]+\//,"");

        } else {
            newName = req.files.file.name;
        }
        // set where the file should actually exists - in this case it is in the "images" directory
        var targetPath = query.path + newName;
        // move the file from the temporary location to the intended location
        fs.rename(tmpPath, targetPath, function(err) {
            if (err) throw err;
            // delete the temporary file, so that the explicitly set temporary upload dir does not get filled with unwanted files
            fs.unlink(tmpPath, function() {
                if (err) throw err;
                res.send('File uploaded to: ' + targetPath + ' - ' + req.files.file.size + ' bytes');
            });
        });
    });

    io = socketio.listen(server);
    io.set('logger', { debug: function(obj) {logger.debug("socket.io: "+obj)}, info: function(obj) {logger.debug("socket.io: "+obj)} , error: function(obj) {logger.error("socket.io: "+obj)}, warn: function(obj) {logger.warn("socket.io: "+obj)} });
    initSocketIO();
}


function initSocketIO() {
    io.sockets.on('connection', function (socket) {
        socketlist.push(socket);
        var address = socket.handshake.address;
        logger.verbose("socket.io <-- " + address.address + ":" + address.port + " " + socket.transport + " connected");

        socket.on('readdir', function (path, callback) {
            path = __dirname+"/"+path;
            logger.info("socket.io <-- readdir "+path);
            fs.readdir(path, function (err, data) {
               if (err) {
                    callback(undefined);
               } else {
                   callback(data);
               }
            });
        });

        socket.on('writeFile', function (name, obj, callback) {
            var content = JSON.stringify(obj);
            logger.verbose("socket.io <-- writeFile "+name+" "+content);
            fs.writeFile(settings.datastorePath+name, content);
            // Todo Fehler abfangen
            if (callback) { callback(); }
        });

        socket.on('readFile', function (name, callback) {
            logger.verbose("socket.io <-- readFile "+name);

            fs.readFile(settings.datastorePath+name, function (err, data) {
                if (err) {
                    logger.error("ccu.io        failed loading file "+settings.datastorePath+name);
                    callback(undefined);
                } else {
                    var obj = JSON.parse(data);
                    callback(obj);
                }
            });
        });

        socket.on('readRawFile', function (name, callback) {
            logger.verbose("socket.io <-- readFile "+name);

            fs.readFile(__dirname+"/"+name, function (err, data) {
                if (err) {
                    logger.error("ccu.io        failed loading file "+__dirname+"/"+name);
                    callback(undefined);
                } else {
                    callback("\""+data+"\"");
                }
            });
        });




        socket.on('getDatapoints', function(callback) {
            logger.verbose("socket.io <-- getData");
            callback(datapoints);
        });

        socket.on('getObjects', function(callback) {
            logger.verbose("socket.io <-- getObjects");
            callback(regaObjects);
        });


        socket.on('getIndex', function(callback) {
            logger.verbose("socket.io <-- getIndex");
            callback(regaIndex);
        });

        socket.on('setState', function(arr, callback) {
            // Todo Delay!
            logger.verbose("socket.io <-- setState "+JSON.stringify(arr));
            var id =    parseInt(arr[0], 10),
                val =   arr[1],
                ts =    arr[2],
                ack =   arr[3];
            if (!ts) {
                var timestamp = new Date();
                var ts = timestamp.getFullYear() + '-' +
                    ("0" + (timestamp.getMonth() + 1).toString(10)).slice(-2) + '-' +
                    ("0" + (timestamp.getDate() + 1).toString(10)).slice(-2) + ' ' +
                    ("0" + (timestamp.getHours()).toString(10)).slice(-2) + ':' +
                    ("0" + (timestamp.getMinutes()).toString(10)).slice(-2) + ':' +
                    ("0" + (timestamp.getSeconds()).toString(10)).slice(-2);
            }


            // console.log("id="+id+" val="+val+" ts="+ts+" ack="+ack);
            // console.log("datapoints[id][0]="+datapoints[id][0]);


            // If ReGa id (0-65534) and not acknowledged -> Set Datapoint on the CCU
            if (id < 65535 && ((val !== datapoints[id][0] && !ack) || (regaObjects[id].Name.match(/.*PRESS_SHORT/) || regaObjects[id].Name.match(/.*PRESS_LONG/)))) {
                // TODO implement set State via BINRPC if TypeName=HSSDP
                // // Bidcos or Rega?
                //if (regaIndex.HSSDP.indexOf(id) != -1) {
                    // BINRPC
                    //var name = regaObjects[id].Name;
                    //var parts = name.split(".");
                    //var iface = parts[0],
                    //    channel = parts[1],
                    //    dp = parts[2];
                //} else {
                    // ReGa
                    var xval;
                    if (typeof val == "string") {
                        xval = "'" + val.replace(/'/g, '"') + "'";
                    } else {
                        xval = val;
                    }
                    var script = "Write(dom.GetObject("+id+").State("+xval+"));";

                    regahss.script(script, function (data) {
                         //logger.verbose("rega      <-- "+data);
                         if (callback) {
                             callback(data);
                         }
                    });

                //}

            }

            setDatapoint(id, val, ts, ack);

        });

        socket.on('programExecute', function(id, callback) {
            logger.verbose("socket.io <-- runProgram");
            regahss.script("Write(dom.GetObject("+id+").ProgramExecute());", function (data) {
                if (callback) { callback(data); }
            });
        });

        socket.on('runScript', function(script, callback) {
            logger.verbose("socket.io <-- script");
            regahss.script(script, function (data) {
                if (callback) { callback(data); }
            });
        });

        socket.on('disconnect', function () {
            var address = socket.handshake.address;
            logger.verbose("socket.io <-- " + address.address + ":" + address.port + " " + socket.transport + " disconnected");
            socketlist.splice(socketlist.indexOf(socket), 1);
        });
        socket.on('close', function () {
            var address = socket.handshake.address;
            logger.verbose("socket.io <-- " + address.address + ":" + address.port + " " + socket.transport + " closed");
            socketlist.splice(socketlist.indexOf(socket), 1);
        });
    });
    logger.info("ccu.io        ready");
}

process.on('SIGINT', function () {
    stop();
});

process.on('SIGTERM', function () {
    stop();
});

function stop() {
    socketlist.forEach(function(socket) {
        logger.verbose("socket.io --> disconnecting socket");
        socket.disconnect();
    });

    if (io) {
        logger.verbose("socket.io     closing server");
        io.server.close();
    }

    setTimeout(quit, 500);
}

function quit() {
    if (regahss.pendingRequests > 0) {
        logger.verbose("rega          waiting for pending request...");
        setTimeout(quit, 500);
    } else {
        logger.info("ccu.io uptime "+stats.uptime());
        logger.info("ccu.io        terminating");
        setTimeout(function () {
            process.exit(0);
        }, 250);
    }
}

function cacheLog(str) {
    devlogCache.push(str);
}

function writeLog() {
    var tmp = devlogCache;
    devlogCache = [];
    var l = tmp.length;
    logger.verbose("ccu.io        writing "+l+" lines to "+settings.logging.file);
    for (var i = 0; i < l; i++) {
        devlog.write(tmp[i]);
    }
}

function moveLog() {
    setTimeout(moveLog, 86400000);
    var ts = (new Date()).getTime() - 3600000;
    ts = new Date(ts);

    logger.verbose("ccu.io        moving Logfile");

    var timestamp = ts.getFullYear() + '-' +
        ("0" + (ts.getMonth() + 1).toString(10)).slice(-2) + '-' +
        ("0" + (ts.getDate()).toString(10)).slice(-2);

    devlog.close();

    fs.rename(__dirname+"/log/"+settings.logging.file, __dirname+"/log/"+settings.logging.file+"."+timestamp, function() {
        devlog = fs.createWriteStream(__dirname+"/log/"+settings.logging.file, {
            flags: "a", encoding: "utf8", mode: 0644
        });
    });

}
