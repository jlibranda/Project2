'use strict';
const assert = require('assert');
const core = require('../public/payroll-adjustment-core');

assert.equal(core.isReady({status:'ready'}),true);
assert.equal(core.isReady({status:'pending'}),true,'Legacy pending adjustments become ready without approval');
assert.equal(core.isReady({status:'approved'}),true,'Legacy approved adjustments remain ready');
assert.equal(core.isReady({status:'applied'}),false);
assert.equal(core.canDelete({id:1,status:'ready'}),true);
assert.equal(core.canDelete({id:2,status:'applied'}),false);
assert.equal(core.canDelete({id:3,status:'ready',payrollRunId:10}),false,'Submitted adjustments must preserve payroll history');
assert.deepStrictEqual(core.deletableIds([{id:1,status:'ready'},{id:2,status:'applied'},{id:3,status:'pending'}],[1,2,3]),[1,3]);
console.log('Payroll adjustment lifecycle tests passed.');
