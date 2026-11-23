'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {createConversationStore}=require('../bot/courier-conversations');
test('чужое сообщение не потребляет ожидающий диалог',()=>{const s=createConversationStore();s.set(100,100,'registration',{marker:'A'});assert.equal(s.take(200,200),null);assert.equal(s.get(100,100).payload.marker,'A');assert.equal(s.take(100,100).payload.marker,'A');});
test('диалоги изолированы по чату и Telegram ID',()=>{const s=createConversationStore();s.set(100,100,'car',{courierId:1});s.set(200,200,'photo_order',{courierId:2});assert.equal(s.take(100,200),null);assert.equal(s.get(100,100).type,'car');assert.equal(s.get(200,200).type,'photo_order');});
test('команда отменяет только собственный диалог',()=>{const s=createConversationStore();s.set(100,100,'registration');s.set(200,200,'car');s.clear(100,100);assert.equal(s.get(100,100),null);assert.equal(s.get(200,200).type,'car');});
test('просроченный диалог удаляется',()=>{let clock=1000;const s=createConversationStore({ttlMs:100,now:()=>clock});s.set(100,100,'registration');clock+=101;assert.equal(s.take(100,100),null);assert.equal(s.get(100,100),null);});
