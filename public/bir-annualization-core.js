/* BIR annualized withholding helpers based on RR 11-2018 Annex E (2023 onwards). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BIRAnnualizationCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var TABLES_2023 = {
    annual:[{from:0,base:0,rate:0},{from:250000,base:0,rate:15},{from:400000,base:22500,rate:20},{from:800000,base:102500,rate:25},{from:2000000,base:402500,rate:30},{from:8000000,base:2202500,rate:35}],
    monthly:[{from:0,base:0,rate:0},{from:20833,base:0,rate:15},{from:33333,base:1875,rate:20},{from:66667,base:8541.80,rate:25},{from:166667,base:33541.80,rate:30},{from:666667,base:183541.80,rate:35}],
    'semi-monthly':[{from:0,base:0,rate:0},{from:10417,base:0,rate:15},{from:16667,base:937.50,rate:20},{from:33333,base:4270.70,rate:25},{from:83333,base:16770.70,rate:30},{from:333333,base:91770.70,rate:35}],
    weekly:[{from:0,base:0,rate:0},{from:4808,base:0,rate:15},{from:7692,base:432.60,rate:20},{from:15385,base:1971.20,rate:25},{from:38462,base:7740.45,rate:30},{from:153846,base:42355.65,rate:35}],
    daily:[{from:0,base:0,rate:0},{from:685,base:0,rate:15},{from:1096,base:61.65,rate:20},{from:2192,base:280.85,rate:25},{from:5479,base:1102.60,rate:30},{from:21918,base:6034.30,rate:35}]
  };
  function money(value){return Math.round((Number(value)||0)*100)/100;}
  function taxDue(income,frequency,tables){
    var rows=(tables&&tables[frequency])||TABLES_2023[frequency]||TABLES_2023.annual;
    var value=Math.max(0,Number(income)||0),row=rows[0];
    for(var i=0;i<rows.length;i++)if(value>=rows[i].from)row=rows[i];
    return money(row.base+(value-row.from)*(row.rate/100));
  }
  function normalizeEvent(value){return ['regular','annualized-year-end','annualized-final-pay'].indexOf(value)>=0?value:'regular';}
  function profileForYear(employee,year){
    return ((employee&&employee.taxYearRecords)||[]).find(function(record){return Number(record.year)===Number(year);})||null;
  }
  function validateProfile(record,year,required){
    if(!required)return[];
    if(!record)return['Tax record for '+year+' is missing. Confirm whether the employee had a previous employer.'];
    if(record.confirmed!==true)return['Tax record for '+year+' is not confirmed.'];
    if(record.hasPreviousEmployer&&!(record.sourceReference||'').trim())return['Previous-employer source/reference is required.'];
    return[];
  }
  function reconcile(input){
    input=input||{};
    var currentTaxable=money(input.currentTaxable),ytdTaxable=money(input.ytdTaxable),openingYtdTaxable=money(input.openingYtdTaxable),previousEmployerTaxable=money(input.previousEmployerTaxable);
    var ytdTaxWithheld=money(input.ytdTaxWithheld),openingYtdTaxWithheld=money(input.openingYtdTaxWithheld),previousEmployerTaxWithheld=money(input.previousEmployerTaxWithheld);
    var annualTaxable=money(currentTaxable+ytdTaxable+openingYtdTaxable+previousEmployerTaxable);
    var annualTax=money((input.taxFunction||function(value){return taxDue(value,'annual');})(annualTaxable));
    var taxPaidBefore=money(ytdTaxWithheld+openingYtdTaxWithheld+previousEmployerTaxWithheld);
    var adjustment=money(annualTax-taxPaidBefore);
    return {currentTaxable:currentTaxable,ytdTaxable:ytdTaxable,openingYtdTaxable:openingYtdTaxable,previousEmployerTaxable:previousEmployerTaxable,annualTaxable:annualTaxable,annualTax:annualTax,taxPaidBefore:taxPaidBefore,adjustment:adjustment,withholding:money(Math.max(0,adjustment)),refund:money(Math.max(0,-adjustment))};
  }
  return {TABLES_2023:TABLES_2023,money:money,taxDue:taxDue,normalizeEvent:normalizeEvent,profileForYear:profileForYear,validateProfile:validateProfile,reconcile:reconcile};
}));
