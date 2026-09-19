// Entry point used by run.sh.
//
// Deliberately a different filename from index.js: a background server started
// this way then has "server/serve.js --instance=<name>" on its command line, so
// a broad `pkill -f "server/index.js"` aimed at someone's foreground dev server
// does not take it down too.
import './index.js';
