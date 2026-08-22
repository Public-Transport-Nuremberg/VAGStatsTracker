#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const Redis = require('ioredis');

const printHelp = () => {
    console.log(`Create a KeyDB-backed VAGStats admin Webtoken.

Usage:
  npm run create-admin-token -- [options]

Options:
  --username <name>  Display name stored with the token (default: cli-admin)
  --hours <number>   Token lifetime in hours (default: WebTokenDurationH or 96)
  --length <number>  Token length, minimum 32 (default: WEBTOKENLENGTH or 64)
  --json             Print machine-readable JSON
  --help             Show this help
`);
};

const readOption = (args, name) => {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) {
        throw new Error(`${name} requires a value`);
    }
    return args[index + 1];
};

const parseInteger = (value, fallback, name, minimum, maximum) => {
    const parsed = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return parsed;
};

const createToken = (length) => crypto.randomBytes(Math.ceil(length * 0.75) + 2)
    .toString('base64url')
    .slice(0, length);

const main = async (args = process.argv.slice(2), RedisClient = Redis) => {
    if (args.includes('--help')) {
        printHelp();
        return;
    }

    const supportedOptions = new Set(['--username', '--hours', '--length', '--json']);
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (!argument.startsWith('--')) continue;
        if (!supportedOptions.has(argument)) throw new Error(`Unknown option: ${argument}`);
        if (argument !== '--json') index++;
    }

    if (String(process.env.CACHEDRIVER || 'redis').toLowerCase() === 'local') {
        throw new Error('CACHEDRIVER=local cannot consume KeyDB admin tokens; use CACHEDRIVER=redis');
    }

    const username = readOption(args, '--username') || 'cli-admin';
    if (username.length > 128) throw new Error('--username must not exceed 128 characters');

    const defaultHours = Number(process.env.WebTokenDurationH) || 96;
    const defaultLength = Number(process.env.WEBTOKENLENGTH || process.env.WebTokenLength) || 64;
    const hours = parseInteger(readOption(args, '--hours'), defaultHours, '--hours', 1, 8760);
    const length = parseInteger(readOption(args, '--length'), defaultLength, '--length', 32, 512);
    const ttlSeconds = hours * 60 * 60;

    const redis = new RedisClient({
        port: process.env.REDIS_PORT || process.env.Redis_Port || 6379,
        host: process.env.REDIS_HOST || process.env.Redis_Host || '127.0.0.1',
        username: process.env.REDIS_USER || process.env.Redis_User || 'default',
        password: process.env.REDIS_PASSWORD || process.env.Redis_Password || 'default',
        db: process.env.REDIS_DB || process.env.Redis_DB || 0,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
    });

    try {
        let token;
        do {
            token = createToken(length);
        } while (await redis.exists(`WT:${token}`));

        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + (ttlSeconds * 1000));
        const tokenData = {
            user_id: 0,
            puuid: crypto.randomUUID(),
            username,
            avatar_url: '',
            permissions: ['*'],
            user_group: 'admin',
            browser: '*',
            language: 'de',
            design: 'default',
            time: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
        };

        await redis.set(`WT:${token}`, JSON.stringify(tokenData), 'EX', ttlSeconds);

        const result = {
            token,
            username,
            permissions: ['*'],
            createdAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
        };

        if (args.includes('--json')) {
            console.log(JSON.stringify(result));
        } else {
            console.log('Admin token created successfully.');
            console.log(`Username: ${result.username}`);
            console.log(`Expires:  ${result.expiresAt}`);
            console.log(`Token:    ${result.token}`);
            console.log('\nStore this token securely; it grants unrestricted access.');
        }
    } finally {
        await redis.quit().catch(() => redis.disconnect());
    }
};

if (require.main === module) {
    main().catch((error) => {
        console.error(`Failed to create admin token: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { createToken, main, parseInteger };
