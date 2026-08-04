/* Effective-dated BIR withholding tables and annual benefit-bucket helpers. */
(function(root,factory){var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BIRTaxVersionCore=api;}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  var FREQUENCIES=['annual','monthly','semi-monthly','weekly','daily'];
  function money(v){return Math.round((Number(v)||0)*100)/100;}
  function copy(v){return JSON.parse(JSON.stringify(v));}
  function selectVersion(versions,date){
    var d=String(date||'9999-12-31');
    return (versions||[]).filter(function(v){return v.status==='active'&&(!v.effectiveFrom||v.effectiveFrom<=d)&&(!v.effectiveTo||v.effectiveTo>=d);}).sort(function(a,b){return String(b.effectiveFrom||'').localeCompare(String(a.effectiveFrom||''))||Number(b.version||0)-Number(a.version||0);})[0]||null;
  }
  function taxDue(income,frequency,version){
    var rows=version&&version.tables&&version.tables[frequency];if(!rows||!rows.length)return 0;
    var value=Math.max(0,Number(income)||0),row=rows[0];
    for(var i=0;i<rows.length;i++)if(value>=Number(rows[i].from||0))row=rows[i];
    return money(Number(row.base||0)+(value-Number(row.from||0))*(Number(row.rate||0)/100));
  }
  function validateVersion(version,versions){
    var issues=[];if(!version) return ['Tax-table version is missing.'];
    if(!(version.name||'').trim())issues.push('Version name is required.');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(version.effectiveFrom||''))issues.push('A valid Effective From date is required.');
    if(version.effectiveTo&&version.effectiveTo<version.effectiveFrom)issues.push('Effective To cannot be before Effective From.');
    FREQUENCIES.forEach(function(freq){
      var rows=version.tables&&version.tables[freq];if(!rows||rows.length<2){issues.push(freq+': at least two brackets are required.');return;}
      rows.forEach(function(row,index){
        if(index===0&&Number(row.from)!==0)issues.push(freq+': first bracket must start at zero.');
        if(index&&Number(row.from)<=Number(rows[index-1].from))issues.push(freq+': brackets must be strictly ascending.');
        if(Number(row.base)<0||Number(row.rate)<0||Number(row.rate)>100)issues.push(freq+': base and rate must be valid non-negative values.');
      });
    });
    if(version.status==='active'){
      (versions||[]).filter(function(v){return v.id!==version.id&&v.status==='active';}).forEach(function(other){
        var a1=version.effectiveFrom||'0000-01-01',a2=version.effectiveTo||'9999-12-31',b1=other.effectiveFrom||'0000-01-01',b2=other.effectiveTo||'9999-12-31';
        if(a1<=b2&&b1<=a2)issues.push('Active effective dates overlap '+other.name+'.');
      });
    }
    return Array.from(new Set(issues));
  }
  function cloneVersion(source,options){var v=copy(source||{}),o=options||{};v.id=o.id||('BIR-'+Date.now());v.version=Number(o.version||Number(v.version||0)+1);v.name=o.name||((v.name||'BIR Tax Table')+' Copy');v.effectiveFrom=o.effectiveFrom||'';v.effectiveTo=o.effectiveTo||'';v.status='draft';v.createdAt=o.createdAt||new Date().toISOString();v.createdBy=o.createdBy||'System';delete v.approvedAt;delete v.approvedBy;return v;}
  function allocateAnnualBenefit(input){
    input=input||{};var limit=Math.max(0,Number(input.limit==null?90000:input.limit));
    var previous=money(input.previousEmployerNonTaxable),currentYtd=money(input.currentEmployerYtdNonTaxable),qualified=money(input.currentQualified);
    var usedBefore=money(previous+currentYtd),remaining=money(Math.max(0,limit-usedBefore)),exempt=money(Math.min(qualified,remaining)),taxable=money(Math.max(0,qualified-exempt));
    return{limit:limit,previousEmployerNonTaxable:previous,currentEmployerYtdNonTaxable:currentYtd,usedBefore:usedBefore,remainingBefore:remaining,currentQualified:qualified,exempt:exempt,taxable:taxable,remainingAfter:money(Math.max(0,remaining-exempt))};
  }
  function validatePreviousEmployer(record){
    var issues=[];if(!record||!record.hasPreviousEmployer)return issues;
    if(!(record.previousEmployerName||'').trim())issues.push('Previous employer name is required.');
    if(!(record.sourceReference||'').trim())issues.push('BIR 2316/source reference is required.');
    var nonTax=Math.max(0,Number(record.previousEmployerNonTaxableBenefits||0));if(nonTax>90000)issues.push('Previous-employer non-taxable 13th-month/other benefits cannot exceed P90,000.');
    var taxableBonus=Math.max(0,Number(record.previousEmployerTaxableBenefits||0)),totalTaxable=Math.max(0,Number(record.previousEmployerTaxable||0));if(taxableBonus>totalTaxable)issues.push('Previous-employer taxable benefits cannot exceed total taxable compensation.');
    if(record.previousEmploymentFrom&&record.previousEmploymentTo&&record.previousEmploymentFrom>record.previousEmploymentTo)issues.push('Previous-employer employment dates are invalid.');
    return issues;
  }
  return{FREQUENCIES:FREQUENCIES,money:money,copy:copy,selectVersion:selectVersion,taxDue:taxDue,validateVersion:validateVersion,cloneVersion:cloneVersion,allocateAnnualBenefit:allocateAnnualBenefit,validatePreviousEmployer:validatePreviousEmployer};
}));
