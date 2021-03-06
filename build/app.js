"use strict";
const bodyParser = require("body-parser");
const crypto = require("crypto");
const express = require("express");
const Opts = require("node-getopt");
const _ = require("lodash");
const getopt = new Opts([
    ['b', 'bot-names=ARG+', 'Determines which bots will run'],
    ['h', 'help', 'This help message'],
]);
getopt.setHelp(`
Usage: ${process.argv[1].split('/').slice(-1)} [OPTION]
[[OPTIONS]]
`);
const opt = getopt.parse(process.argv.slice(2));
if (opt.options['help'] || Object.keys(opt.options).length === 0) {
    console.log(getopt.getHelp());
    process.exit(0);
}
function verifyWebhookToken(payload, hubSignature) {
    const newHmac = crypto.createHmac('sha1', process.env.WEBHOOK_SECRET);
    newHmac.update(payload);
    if (('sha1=' + newHmac.digest('hex')) === hubSignature) {
        return true;
    }
    return false;
}
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
let botRegistry = [];
for (let bot of opt.options['bot-names']) {
    try {
        let importedBot = require(`./bots/${bot}`);
        botRegistry.push(importedBot.createBot());
        console.log(`Imported ${bot}...`);
    }
    catch (err) {
        console.log(`Could not import bot type ${bot}`);
        console.log(err);
        throw err;
    }
}
app.post('/webhooks', (req, res) => {
    const eventType = req.get('x-github-event');
    const payload = req.body;
    if (!verifyWebhookToken(JSON.stringify(payload), req.get('x-hub-signature'))) {
        res.sendStatus(401);
        return;
    }
    res.sendStatus(200);
    _.forEach(botRegistry, (bot) => {
        bot.firedEvent(eventType, payload);
    });
});
app.listen(4567, () => {
    console.log(`---> ${process.env.npm_package_name}, Version ${process.env.npm_package_version} <---`);
    console.log('Listening for Github Integration hooks on port 4567.');
});

//# sourceMappingURL=app.js.map
