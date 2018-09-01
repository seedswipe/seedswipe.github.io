build:
	`npm bin`/browserify src.js -d > built.js
	`npm bin`/browserify node_modules/hd-wallet/lib/socketio-worker/inside.js -d > socket-worker.js
	`npm bin`/browserify node_modules/hd-wallet/lib/discovery/worker/inside/index.js -d > discovery-worker.js
	cp node_modules/hd-wallet/lib/fastxpub/fastxpub.js .
	cp node_modules/hd-wallet/lib/fastxpub/fastxpub.wasm .

