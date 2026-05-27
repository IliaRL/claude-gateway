/**
 * 获取北京时间 (UTC+8) 的日期字符串 (YYYY-MM-DD)
 */
export function getBeijingDateString() {
    const now = new Date();
    const utc8Time = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    return utc8Time.toISOString().split('T')[0];
}
