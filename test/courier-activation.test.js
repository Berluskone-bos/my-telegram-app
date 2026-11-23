'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {parseCourierActivation}=require('../bot/courier-activation');

test('разбирает callback активации с положительным ID и одноразовым токеном',()=>{
 const token=Array.from({length:32},(_,i)=>'fedcba9876543210'[i%16]).join('');
 assert.deepEqual(parseCourierActivation(`activate_courier_123_${token}`),{id:123,token});
 assert.deepEqual(parseCourierActivation(`activate_courier_2147483647_${token}`),{id:2147483647,token});
});

test('отклоняет callback без токена, с повреждённым токеном и ID вне диапазона',()=>{
 for(const value of ['activate_courier_123','activate_courier_123_invalid','activate_courier_0','activate_courier_2147483648','activate_courier_-1','activate_courier_123_abc',null,undefined,123]) {
  assert.equal(parseCourierActivation(value),null,String(value));
 }
});
