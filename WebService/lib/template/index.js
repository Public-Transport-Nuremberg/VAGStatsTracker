const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const package_json = require('../../package.json');
const { execSync } = require('child_process');
const app = require('@src/app');

let commitId = null;

// Get the commit ID of the current build
try {
    const commitId_long = execSync('git rev-parse HEAD').toString().trim();
    commitId = commitId_long.slice(0, 7);
} catch (error) {
    console.error('Error fetching commit ID:', error);
}


/**
 * Render all EJS files in a directory to HTML files in another directory
 * @param {String} sourceDir 
 * @param {String} destDir 
 * @param {Object} exclude 
 */
const renderEJSToPublic = (sourceDir, destDir, exclude = []) => {
    // Normalize paths in the exclude list
    const context = getContextObject();
    const excludePaths = exclude.map(exPath => path.normalize(exPath));
    fs.readdirSync(sourceDir, { withFileTypes: true }).forEach(dirent => {
        const sourcePath = path.join(sourceDir, dirent.name);
        const relativeSourcePath = path.relative(sourceDir, sourcePath);
        const destPath = path.join(destDir, dirent.name).replace('.ejs', '.html');

        if (excludePaths.includes(relativeSourcePath)) return;

        if (dirent.isDirectory()) {
            if (!fs.existsSync(destPath)) {
                fs.mkdirSync(destPath, { recursive: true });
            }
            renderEJSToPublic(sourcePath, destPath, exclude);
        } else if (path.extname(sourcePath) === '.ejs') {
            ejs.renderFile(sourcePath, context, (err, str) => {
                if (err) throw err;
                fs.writeFileSync(destPath, str);
            });
        }
    });
};

/**
 * Generate the context object to pass to EJS templates
 * @returns {Object} - The context object to pass to EJS templates
 */
const getContextObject = () => {
    const context = {
        domain: process.env.DOMAIN,
        commitId: commitId,
        appName: process.env.APPLICATION,
        version: package_json.version,
    };

    return context;
};

module.exports = {
    renderEJSToPublic,
    getContextObject,
};