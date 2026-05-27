import * as crypto from 'crypto';

/**
 * Generates an MD5 hash for a given object by first converting it to a JSON string.
 */
export function getMD5Hash(obj) {
    const jsonString = JSON.stringify(obj);
    return crypto.createHash('md5').update(jsonString).digest('hex');
}
