Discover existing then figure out how to execute: We need new lexicon com.publicdomainrelay.temp.compute.deno.workerManifest. It should have https://badge.blue style signatures property. We'll be leveraging our existing deno-worker-sandbox repo and CLI patterns. We want the record to have properties:

- source (object, optional):
  - tangled: sh.tangled.repo (optional, strongRef)
  - git: (optional, url)
- lock: string, contents of deno.lock
- json: string, contents of deno.json
- bundle: string, contents of bundle.js resulting from deno-worker-sandbox build
- config: (optional string), contents of config.json
- configref: (optional strongRef), ref to com.publicdomainrelay.temp.compute.deno.workerConfig(make this lexicon, property: payload type string)

Alos, we need new lexicon com.publicdomainrelay.temp.compute.deno.workerInstance. It should have https://badge.blue style signatures property.

- manifest: (strongRef), ref to com.publicdomainrelay.temp.compute.deno.workerManifest

Then we want to add to our deno-worker-sandbox implementation so that it
supports and we have a testcase where we spin ephemeral did-plc-directory
and local-pds instances and have routes (and lib class methods underneath):

- registerWokerManifest (xrpc route)
  - Returns a ref to com.publicdomainrelay.temp.compute.deno.workerManifest
      created manifest.
    - In configured PDS external PDS if serviceAuthToken or (ATPROTO_HANDLE and
        ATPROTO_PASSWORD) provided
      - In local-pds if running ephemeral local-pds for test or configured via
        CLI. If running in CLI mode should also support hosting local PDS over
        XRPC relay.

- runPersistantWokerInstance (xrpc route)

    - Should starting persistant worker instance

- executeWokerInstance (xrpc route)

    - should take an object
        com.publicdomainrelay.temp.compute.deno.workerRequest which we need to
        define which is the HTTP request object to send to the worker.

CLI should support hosting over xrpc relay or bare port or unix socket
