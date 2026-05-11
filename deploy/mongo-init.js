// Mongo init script — runs ONCE on first container boot (when /data/db
// is empty). Used to bootstrap the replica set so the healthcheck has
// something to grab onto. Subsequent boots see the existing rs0 config
// and this script is skipped.
//
// Mongoose transactions require a replica set (even a single-node one).
// We initialise rs0 with `mongodb` as the host so the connection string
// `mongodb://mongodb:27017/?replicaSet=rs0` works inside the network.

try {
  const status = rs.status();
  print('Replica set already initialised: ' + status.set);
} catch (e) {
  print('Initialising replica set rs0…');
  rs.initiate({
    _id: 'rs0',
    members: [{ _id: 0, host: 'mongodb:27017' }],
  });
  print('Done.');
}
