// Runs ONCE, the first time the mongo container starts on an empty data volume.
// The Docker entrypoint runs it as the root user. It creates a least-privilege
// application user (readWrite on the app database only) so the API never uses
// the root credentials.
//
// If the data volume already has data, this does not run — create the user by
// hand (see HETZNER_DEPLOY.md) if you ever need to.
(function () {
  const dbName = process.env.APP_DB || "inc_logistics";
  const user = process.env.APP_USER;
  const pwd = process.env.APP_PASSWORD;

  if (!user || !pwd) {
    print("mongo-init: APP_USER/APP_PASSWORD not set — skipping app-user creation");
    return;
  }

  const appDb = db.getSiblingDB(dbName);
  const exists = appDb.getUsers().users.some((u) => u.user === user);
  if (exists) {
    print(`mongo-init: app user '${user}' already exists on ${dbName}`);
    return;
  }

  appDb.createUser({
    user: user,
    pwd: pwd,
    roles: [{ role: "readWrite", db: dbName }],
  });
  print(`mongo-init: created app user '${user}' with readWrite on ${dbName}`);
})();
