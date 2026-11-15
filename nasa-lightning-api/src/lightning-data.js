'use strict';

const path = require('node:path');

process.chdir(path.join(__dirname, 'nasa-lightning-api'));
require('./server');