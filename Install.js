const path = require('node:path');
const exec = require('node:child_process').exec;

const fs = require("node:fs");
const readline = require('node:readline');
const { exit } = require('node:process');

let global_config;

if (!fs.existsSync(path.join(__dirname, "global.json"))) {
    fs.rename(path.join(__dirname, "global.json.example"), path.join(__dirname, "global.json"), (err) => {
        if (err) throw err;
    });
}

global_config = require('./global.json');

const debug = false;

// Misc
/**
 * Will replace all {{Variables}} with the corresponding value of the Key
 * @param {String} templateid 
 * @param {Object} data 
 * @returns {String}
 */
function template(templateid, data) {
    if (typeof (templateid) !== 'string' || typeof (data) !== 'object') { throw new Error('Template expects string and object'); }
    return templateid
        .replace(
            /{{2}(\w*)}{2}/g,
            function (m, key) {
                return data.hasOwnProperty(key) ? data[key] : "NULL";
            }
        );
}

/**
 * Print a message to the console and wait for user input
 * @param {String} query | The message to print
 * @returns 
 */
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }))
}

/**
 * Run a cli command within node as async function in a specific directory
 * @param {String} command | The command to execute
 * @param {String} cwd | Path to execute the command in
 * @param {String} message | Message to print after executing the command
 * @param {Boolean} [live] | If true, it will print stdout and stderr live
 * @returns 
 */
function executeCommand(command, cwd, message, live = false) {
    return new Promise(function (resolve, reject) {
        process.stdout.write(message.split("|")[0]);
        exec(command, { cwd: cwd }, (error, stdout, stderr) => {
            if (error) {
                console.log(`EXEC error: ${error}`);
                return;
            }
            if (stdout || stderr) {
                if (live) {
                    console.log(stdout || "");
                    console.log(stderr || "");
                }
            }
            process.stdout.write(message.split("|")[1]);
            process.stdout.write("\n");
            resolve();
        })
    });
}

// Installer
//await executeCommand(YARN_Install, PlugsServerPath, 'Installed PlugsServer dependencies');
(async () => {
    const Run_type = await askQuestion('What do you want to do?\n1: Install\n2: Update\n> ');

    for (i = 0; i < global_config.services.length; i++) {
        const service = global_config.services[i];
        const name = service.name;
        const root_path = service.root_path;
        const env = service.env;

        if (Run_type == 1) {
            console.log(`\nInstalling ${global_config.services[i].name}...`);
            for (j = 0; j < service.install_instructions.length; j++) {
                const instruction = service.install_instructions[j];

                const type = instruction.type;
                const path_rel = instruction.path;
                const command = instruction.command;

                if (type === 'fs') {
                    if (!fs.existsSync(path.join(__dirname, root_path, path_rel, command))) {
                        fs.mkdirSync(path.join(__dirname, root_path, path_rel, command), { recursive: true });
                    }
                } else if (type === 'shell') {
                    await executeCommand(command, path.join(__dirname, root_path, path_rel), `Running ${command} in ${path.join(__dirname, root_path, path_rel)}| [Done]`, debug);
                } else if (type === 'template') {
                    const template_path = path.join(__dirname, 'Installer/Templates', `${name.toLocaleLowerCase()}-${command}`);
                    const template_content = fs.readFileSync(template_path, 'utf8');

                    const template_result = template(template_content, env);

                    console.log(`Generating config file...`);
                    fs.writeFileSync(path.join(__dirname, name, command), template_result);
                }
            }
        } else if (Run_type == 2) {
            if(!service.update_instructions || service.update_instructions.length <= 0) {
                console.log(`\nThis is where i would put my ${name} update instructions, if i had any!`)
                continue;
            }

            console.log(`\nUpdating ${global_config.services[i].name}...`);
            for (j = 0; j < service.update_instructions.length; j++) {
                const instruction = service.update_instructions[j];

                const type = instruction.type;
                const path_rel = instruction.path;
                const command = instruction.command;

                if (type === 'fs') {
                    if (!fs.existsSync(path.join(__dirname, root_path, path_rel, command))) {
                        fs.mkdirSync(path.join(__dirname, root_path, path_rel, command), { recursive: true });
                    }
                } else if (type === 'shell') {
                    await executeCommand(command, path.join(__dirname, root_path, path_rel), `Running ${command} in ${path.join(__dirname, root_path, path_rel)}| [Done]`, debug);
                } else if (type === 'template') {
                    const template_path = path.join(__dirname, 'Installer/Templates', `${name.toLocaleLowerCase()}-${command}`);
                    const template_content = fs.readFileSync(template_path, 'utf8');

                    const template_result = template(template_content, env);

                    console.log(`Generating config file...`);
                    fs.writeFileSync(path.join(__dirname, name, command), template_result);
                }
            }

        }
    }
})();