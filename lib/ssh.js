var resolve = require('./util').resolve;
var bash = require('bash');
var format = require('util').format;
var async = require('async');
var util = require('./util');
var spawn = require('child_process').spawn;

var SSHCommand = module.exports = function SSHCommand(instance, command, callback) {
  this.instance = instance;
  this.log = instance.log.createSublogger('ssh');
  this.awsmo = instance.awsmo;
  this.command = command;

  this.remoteUser = instance.remoteUser;

  var self = this;
  this.ready = awaitReady.call(this);
  this.task = this.run(callback);
}

function runCommandImmediately(publicDnsName, instanceId, awsKeyName, command, callback) {
  var knownHostsFile = util.getKnownHostsFile(instanceId);

  var sshKeyFile = this.awsmo.opts.sshKeyMappings[awsKeyName];
  if (!sshKeyFile)
    return callback(new Error("No SSH key supplied"));
  if (!this.remoteUser)
    return callback(new Error("No remote user supplied"));

  var args = [
    "-q",
    "-o", "UserKnownHostsFile=" + knownHostsFile,
    "-o", "StrictHostKeyChecking=no", // Assume no MITM-attack on first connection #vulnerability #fixme
    "-i", sshKeyFile,
    "-l", this.remoteUser,
    publicDnsName,
    bash.escape.apply(bash, command)
  ];

  this.log.info(bash.escape.apply(null, ['ssh'].concat(args)));

  var child = spawn('ssh', args);
  util.outputToLogger(
      this.log.createSublogger(bash.escape.apply(bash, command)), 
      child);
  child.stdin.end();
  var stdout = '';
  var stderr = '';
  child.stdout.on('data', function(chunk) { stdout += chunk });
  child.stderr.on('data', function(chunk) { stderr += chunk });
  child.on('exit', function (code, signal) {
    if (code) {
      var msg = format("command `%s` on host `%s` exited abnormally " +
                        "with code `%d`, signal `%s` and stderr:\n%s\nstdout:\n%s",
                        command, publicDnsName, code, signal,
                        stderr, stdout);
      var err = new Error(msg);
      err.stdout = stdout;
      err.stderr = stderr;
      err.code = code;
      err.signal = signal;
      return callback(err, stderr);
    }
    callback(null, stdout);
  });
}

function awaitReady() {
  var self = this;
  return this.awsmo.task(function(callback) {
    resolve([self.instance.publicDnsName,
             self.instance.instanceId,
             self.instance.awsKeyName],
            function(err, publicDnsName, instanceId, awsKeyName) {
      if (err) return callback(err);
      self.log.info('Polling for ssh access...');
      var isReady = false;
      async.doUntil(
        function(callback) {
          self.log.info('Polling...');
          runCommandImmediately.call(self, publicDnsName, instanceId, awsKeyName, ['true'], function(err) {
            isReady = !err;
            if (!isReady) self.log.info('Polling determined ssh inaccessible - ' + err);
            if (isReady) callback();
            else setTimeout(callback, self.awsmo.opts.pollDelay);
          });
        },
        function() { return isReady },
        callback
      );
    });
  });
}

SSHCommand.prototype.run = function(callback) {
  var self = this;
  return this.awsmo.task(function(callback) {
    resolve([self.instance.publicDnsName,
             self.instance.instanceId,
             self.instance.awsKeyName,
             self.ready],
            function(err, publicDnsName, instanceId, awsKeyName) {
      if (err) return callback(err);
      runCommandImmediately.call(self, publicDnsName, instanceId, awsKeyName, self.command, callback);
    });
  }).then(callback || this.awsmo._catchError);
}
