import { promises as fs } from 'fs';
import * as path from 'path';
import logger from './logger.js';

export const FETCH_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'fetch_system_prompt.txt');
export const INPUT_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'input_system_prompt.txt');

export function formatExpiryTime(expiryTimestamp) {
    if (!expiryTimestamp || typeof expiryTimestamp !== 'number') return "No expiry date available";
    const diffMs = expiryTimestamp - Date.now();
    if (diffMs <= 0) return "Token has expired";
    let totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

export function formatLog(tag, message, data = null) {
    let logMessage = `[${tag}] ${message}`;
    if (data !== null && data !== undefined) {
        if (typeof data === 'object') {
            const dataStr = Object.entries(data)
                .map(([key, value]) => `${key}: ${value}`)
                .join(', ');
            logMessage += ` | ${dataStr}`;
        } else {
            logMessage += ` | ${data}`;
        }
    }
    return logMessage;
}

export function formatExpiryLog(tag, expiryDate, nearMinutes) {
    const currentTime = Date.now();
    const nearMinutesInMillis = nearMinutes * 60 * 1000;
    const thresholdTime = currentTime + nearMinutesInMillis;
    const isNearExpiry = expiryDate <= thresholdTime;
    const message = formatLog(tag, 'Checking expiry date', {
        'Expiry date': expiryDate,
        'Current time': currentTime,
        [`${nearMinutes} minutes from now`]: thresholdTime,
        'Is near expiry': isNearExpiry
    });
    return { message, isNearExpiry };
}

export async function logConversation(type, content, logMode, logFilename) {
    if (logMode === 'none' || !content) return;
    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} [${type.toUpperCase()}]:\n${content}\n--------------------------------------\n`;
    if (logMode === 'console') {
        logger.info(logEntry);
    } else if (logMode === 'file') {
        try {
            await fs.appendFile(logFilename, logEntry);
        } catch (err) {
            logger.error(`[Error] Failed to write conversation log to ${logFilename}:`, err);
        }
    }
}

/**
 * 将日期转换为系统本地时间格式
 */
export function formatToLocal(dateInput) {
    try {
        if (!dateInput) return '--';
        let finalInput = dateInput;
        if (typeof dateInput === 'number' && dateInput < 10000000000) finalInput = dateInput * 1000;
        const date = new Date(finalInput);
        if (isNaN(date.getTime())) return '--';
        return date.toLocaleString('zh-CN', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
        }).replace(/\//g, '-');
    } catch (e) {
        return '--';
    }
}
