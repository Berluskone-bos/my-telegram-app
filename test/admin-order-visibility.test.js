'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterOrderListItem, filterOrderDetails } = require('../bot/admin-order-visibility');
const order = {id:17,order_number:'AP-123',user_id:'777',user_name:'Иван',phone:'+79990000000',address:'СПб, Невский, 1',total:2500,status:'ASSEMBLING',delivery_type:'delivery',items:[{name:'Масло',qty:2}],payment:'cash',payment_status:'unpaid',comment:'Позвонить после 18:00',created_at:'2026-11-19T10:00:00.000Z'};
test('кладовщик получает в списке только данные для комплектации',()=>{
 const result=filterOrderListItem(order,'warehouse');
 assert.deepEqual(Object.keys(result).sort(),['created_at','delivery_type','id','order_number','status','total'].sort());
 for(const key of ['user_id','user_name','phone','address','payment','comment']) assert.equal(Object.hasOwn(result,key),false,key);
});
test('кладовщик видит состав заказа, но не персональные и платёжные данные',()=>{
 const result=filterOrderDetails(order,'warehouse');
 assert.deepEqual(result.items,order.items);
 for(const key of ['user_id','user_name','phone','address','payment','payment_status','comment']) assert.equal(Object.hasOwn(result,key),false,key);
});
for(const role of ['admin','manager','operator']) test(role+' сохраняет телефон и адрес клиента',()=>{
 assert.equal(filterOrderListItem(order,role).phone,order.phone);
 assert.equal(filterOrderListItem(order,role).address,order.address);
 assert.equal(filterOrderDetails(order,role).phone,order.phone);
 assert.equal(filterOrderDetails(order,role).address,order.address);
});
test('неизвестная роль проходит штатную проверку прав и не меняет проекцию',()=>{
 assert.equal(filterOrderDetails(order,'unknown'),order);
});
