import { compare as bcryptCompare, hash as bcryptHash } from 'bcryptjs';
import { md5 } from '../../php-compat/md5';
import type { Db } from './db';
import type { RequestContext } from './request';

export interface AuthUser {
  uid: number;
  name: string;
  password: string;
  mail: string;
  screenName: string;
  group: string;
  authCode: string;
}

const TYPECHO_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PH_PASS_CHARS = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const encoder = new TextEncoder();

export function typechoRandomString(length: number, special = false): string {
  const chars = TYPECHO_CHARS + (special ? '!@#$%^&*()' : '');
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => chars[byte % chars.length]).join('');
}

export function typechoHash(value: string, salt = typechoRandomString(9)): string {
  if (salt.length !== 9) return '';
  const input = encoder.encode(value);
  const saltBytes = encoder.encode(salt);
  if (input.length === 0) return '';

  let last = input[input.length - 1];
  let transformed = '';
  for (const asc of input) {
    last = ((last * saltBytes[(last % asc) % 9] + asc) % 95) + 32;
    transformed += String.fromCharCode(last);
  }
  return `$T$${salt}${md5(transformed)}`;
}

function safeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function rawMd5(input: Uint8Array): Uint8Array {
  const hex = md5(input);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function encodePhpass(input: Uint8Array): string {
  let output = '';
  for (let index = 0; index < input.length;) {
    let value = input[index++];
    output += PH_PASS_CHARS[value & 0x3f];
    if (index < input.length) value |= input[index] << 8;
    output += PH_PASS_CHARS[(value >> 6) & 0x3f];
    if (index++ >= input.length) break;
    if (index < input.length) value |= input[index] << 16;
    output += PH_PASS_CHARS[(value >> 12) & 0x3f];
    if (index++ >= input.length) break;
    output += PH_PASS_CHARS[(value >> 18) & 0x3f];
  }
  return output;
}

function verifyPhpass(password: string, stored: string): boolean {
  if (stored.length !== 34 || !/^\$[PH]\$[5-9A-S][./0-9A-Za-z]{30}$/.test(stored)) return false;
  const countLog2 = PH_PASS_CHARS.indexOf(stored[3]);
  if (countLog2 < 7 || countLog2 > 18) return false;
  const salt = stored.slice(4, 12);
  const passwordBytes = encoder.encode(password);
  const saltBytes = encoder.encode(salt);
  let digest = rawMd5(new Uint8Array([...saltBytes, ...passwordBytes]));
  for (let index = 0; index < 1 << countLog2; index++) {
    digest = rawMd5(new Uint8Array([...digest, ...passwordBytes]));
  }
  return safeEquals(stored, `${stored.slice(0, 12)}${encodePhpass(digest)}`);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(stored)) {
    try {
      const normalized = stored.startsWith('$2y$') ? `$2b$${stored.slice(4)}` : stored;
      if (await bcryptCompare(password, normalized)) return true;
    } catch {
      return false;
    }
  }
  if (stored.startsWith('$P$') || stored.startsWith('$H$')) return verifyPhpass(password, stored);
  if (stored.startsWith('$T$') && stored.length === 44) {
    return safeEquals(stored, typechoHash(password, stored.slice(3, 12)));
  }
  return safeEquals(stored, md5(password));
}

export async function hashPassword(password: string): Promise<string> {
  return bcryptHash(password, 10);
}

export function passwordNeedsRehash(stored: string): boolean {
  const match = /^\$2[aby]\$(\d\d)\$/.exec(stored);
  return !match || Number(match[1]) < 10;
}

export function securityToken(secret: string, suffix: string, user?: Pick<AuthUser, 'authCode' | 'uid'> | null): string {
  const auth = user ? `&${user.authCode}&${user.uid}` : '';
  return md5(`${secret}${auth}&${suffix}`);
}

export function cookiePrefix(rootUrl: string): string {
  return md5(rootUrl);
}

export async function findCurrentUser(db: Db, request: RequestContext): Promise<AuthUser | null> {
  const prefix = cookiePrefix(request.rootUrl);
  const uid = request.cookies.get(`${prefix}__typecho_uid`);
  const authCode = request.cookies.get(`${prefix}__typecho_authCode`);
  if (!uid || !authCode || !/^[1-9]\d*$/.test(uid) || !/^\$T\$.{9}[a-f0-9]{32}$/.test(authCode)) return null;
  const user = await db.first<AuthUser>(
    `SELECT uid, name, password, mail, screenName, "group", authCode FROM table.users WHERE uid = ?`,
    [Number(uid)]
  );
  if (!user?.authCode || !(await verifyPassword(user.authCode, authCode))) return null;
  return user;
}

export async function createLoginCookies(
  rootUrl: string,
  uid: number,
  authCode: string,
  remember: boolean,
  secure: boolean
): Promise<string[]> {
  const prefix = cookiePrefix(rootUrl);
  const path = cookiePath(rootUrl);
  const expires = remember ? '; Max-Age=2592000' : '';
  const secureFlag = secure ? '; Secure' : '';
  const authCookie = encodeURIComponent(typechoHash(authCode));
  return [
    `${prefix}__typecho_uid=${uid}; Path=${path}; HttpOnly; SameSite=Lax${expires}${secureFlag}`,
    `${prefix}__typecho_authCode=${authCookie}; Path=${path}; HttpOnly; SameSite=Lax${expires}${secureFlag}`,
  ];
}

export function clearLoginCookies(rootUrl: string, secure: boolean): string[] {
  const prefix = cookiePrefix(rootUrl);
  const path = cookiePath(rootUrl);
  const secureFlag = secure ? '; Secure' : '';
  return [
    `${prefix}__typecho_uid=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag}`,
    `${prefix}__typecho_authCode=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag}`,
  ];
}

function cookiePath(rootUrl: string): string {
  const path = new URL(rootUrl).pathname.replace(/\/+$/, '');
  return `${path || ''}/`;
}
