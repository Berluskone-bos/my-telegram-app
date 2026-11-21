'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterOrderListItem, filterOrderDetails } = require('../bot/admin-order-visibility');

const order = {
    id:17, order_number:'AP-123', user_id:'777', user_name:'Иван',
    phone:'+79990000000', address:'СПб, Невский, 1', total:2500,
    status:'ASSEMBLING', delivery_type:'delivery',
    items:[{name:'Масло',qty:2}], payment:'cash', payment_status:'unpaid',
    comment:'Внутренняя заметка', created_at:'2026-11-19T10:00:00.000Z'
};

const OPERATOR_LIST_FIELDS = ['id','order_number','phone','total','status','delivery_type','created_at'];
const OPERATOR_DETAIL_FIELDS = ['id','order_number','phone','address','items','total','payment','comment','status','delivery_type','created_at'];

test('оператор в списке получает только поля, необходимые для обработки заказа',()=>{
    const result=filterOrderListItem(order,'operator');
    assert.deepEqual(Object.keys(result).sort(),OPERATOR_LIST_FIELDS.sort());
    assert.equal(result.phone,order.phone);
    assert.equal(result.total,order.total);
    for(const key of ['user_id','user_name','address','payment','payment_status','comment']) {
        assert.equal(Object.hasOwn(result,key),false,key);
    }
});

test('оператор в деталях получает телефон, адрес и состав заказа, но не лишние ПДн и внутренние поля',()=>{
    const result=filterOrderDetails(order,'operator');
    assert.deepEqual(Object.keys(result).sort(),OPERATOR_DETAIL_FIELDS.sort());
    assert.equal(result.phone,order.phone);
    assert.equal(result.address,order.address);
    assert.deepEqual(result.items,order.items);
    assert.equal(result.payment,order.payment);
    assert.equal(result.total,order.total);
    assert.equal(result.comment,order.comment);
    for(const key of ['user_id','user_name','payment_status']) {
        assert.equal(Object.hasOwn(result,key),false,key);
    }
});

test('кладовщик в списке получает операционные поля без суммы заказа',()=>{
    const result=filterOrderListItem(order,'warehouse');
    assert.deepEqual(Object.keys(result).sort(),['created_at','delivery_type','id','order_number','status'].sort());
    assert.equal(Object.hasOwn(result,'total'),false,'warehouse list must not expose order total');
    for(const key of ['user_id','user_name','phone','address','payment','payment_status','comment']) {
        assert.equal(Object.hasOwn(result,key),false,key);
    }
});

test('кладовщик видит состав заказа, но не персональные и финансовые данные',()=>{
    const result=filterOrderDetails(order,'warehouse');
    assert.deepEqual(result.items,order.items);
    assert.equal(Object.hasOwn(result,'total'),false,'warehouse details must not expose order total');
    for(const key of ['user_id','user_name','phone','address','payment','payment_status','comment']) {
        assert.equal(Object.hasOwn(result,key),false,key);
    }
});

for(const role of ['admin','manager']) test(role+' сохраняет полный доступ к данным заказа',()=>{
    assert.equal(filterOrderListItem(order,role),order);
    assert.equal(filterOrderDetails(order,role),order);
    assert.equal(filterOrderListItem(order,role).total,order.total);
    assert.equal(filterOrderDetails(order,role).total,order.total);
});

test('неизвестная роль не получает данные заказа (fail closed)',()=>{
    assert.deepEqual(filterOrderListItem(order,'unknown'),{});
    assert.deepEqual(filterOrderDetails(order,'unknown'),{});
});
