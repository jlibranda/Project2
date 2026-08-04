/* BIR Form 2316 September 2021 (ENCS) data aggregation and PDF overlay. */
(function(root,factory){var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BIR2316Pdf=api;}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function number(v){return Number(v)||0;}
  function money(v){return Math.round(number(v)*100)/100;}
  function clean(v){return String(v==null?'':v).replace(/\s+/g,' ').trim();}
  function datePart(value){var d=String(value||'');return /^\d{4}-\d{2}-\d{2}$/.test(d)?d.slice(5,7)+'/'+d.slice(8,10):'';}
  function fullDate(value){var d=String(value||'');return /^\d{4}-\d{2}-\d{2}$/.test(d)?d.slice(5,7)+'/'+d.slice(8,10)+'/'+d.slice(0,4):'';}
  function employeeName(emp){
    var structured=clean((emp.lastName||'')+', '+(emp.firstName||'')+' '+(emp.middleName||'')+(emp.suffix?' '+emp.suffix:''));
    return structured.replace(/^,\s*$/,'')||clean(emp.name);
  }
  function buildData(input){
    input=input||{};var emp=input.employee||{},company=input.company||{},profile=input.profile||{},year=Number(input.year)||new Date().getFullYear();
    var runs=(input.runs||[]).filter(function(run){return Number(run.taxYear||String(run.bir1601CMonth||run.releaseDate||run.to||'').slice(0,4))===year;});
    var items=[];runs.forEach(function(run){var item=(run.items||[]).find(function(row){return row.empId===emp.id;});if(item)items.push({run:run,item:item});});
    var gross=money(items.reduce(function(s,x){return s+number(x.item.gross);},0));
    var taxable=money(items.reduce(function(s,x){return s+number(x.item.taxableCompensation);},0));
    var mandatory=money(items.reduce(function(s,x){return s+number(x.item.sss)+number(x.item.ph)+number(x.item.pi);},0));
    var benefitExempt=money(items.reduce(function(s,x){return s+number(x.item.annualBenefitExempt);},0));
    var benefitTaxable=money(items.reduce(function(s,x){return s+number(x.item.annualBenefitTaxable);},0));
    var deMinimis=money(items.reduce(function(total,x){return total+(x.item.calculationTrace||[]).filter(function(line){return line.type==='earning'&&line.taxable===false&&String(line.ruleCode||'').indexOf('DEMINIMIS')>=0;}).reduce(function(s,line){return s+number(line.amount);},0);},0));
    var nonTaxable=money(Math.max(0,gross-taxable));
    deMinimis=money(Math.min(deMinimis,Math.max(0,nonTaxable-benefitExempt-mandatory)));
    var otherNonTaxable=money(Math.max(0,nonTaxable-benefitExempt-deMinimis-mandatory));
    var presentTax=money(items.reduce(function(s,x){return s+number(x.item.tax)-number(x.item.taxRefund);},0));
    var previousTaxable=money(profile.previousEmployerTaxable),previousTax=money(profile.previousEmployerTaxWithheld);
    var totalTaxable=money(taxable+previousTaxable),taxDue=money(typeof input.taxDueFunction==='function'?input.taxDueFunction(totalTaxable):items.reduce(function(v,x){return number(x.item.annualTax)||v;},0));
    var taxableParts={basic:0,representation:0,transportation:0,cola:0,housing:0,commission:0,profitSharing:0,directorFees:0,hazard:0,overtime:0,other:0,benefit:benefitTaxable};
    var tracedTaxable=0;
    items.forEach(function(x){(x.item.calculationTrace||[]).filter(function(line){return line.type==='earning'&&line.taxable===true&&!line.annualBenefitBucket;}).forEach(function(line){
      var amount=number(line.amount),key=String((line.code||'')+' '+(line.name||'')).toUpperCase();tracedTaxable+=amount;
      if(/(^|\s)BASIC(\s|$)/.test(key))taxableParts.basic+=amount;
      else if(/REPRESENT/.test(key))taxableParts.representation+=amount;
      else if(/TRANSPORT|MOBILE|LOAD/.test(key))taxableParts.transportation+=amount;
      else if(/(^|\s)COLA(\s|$)|COST OF LIVING/.test(key))taxableParts.cola+=amount;
      else if(/HOUS/.test(key))taxableParts.housing+=amount;
      else if(/COMMISS/.test(key))taxableParts.commission+=amount;
      else if(/PROFIT/.test(key))taxableParts.profitSharing+=amount;
      else if(/DIRECTOR|DIRECTOR.?S FEE/.test(key))taxableParts.directorFees+=amount;
      else if(/HAZARD/.test(key))taxableParts.hazard+=amount;
      else if(/OVERTIME|OT_REG|(^|\s)OT(\s|$)/.test(key))taxableParts.overtime+=amount;
      else taxableParts.other+=amount;
    });});
    var targetBeforeMandatory=money(taxable+mandatory),classified=Object.keys(taxableParts).reduce(function(s,key){return s+number(taxableParts[key]);},0);
    if(!tracedTaxable){taxableParts.basic=Math.max(0,taxable-benefitTaxable);taxableParts.other=Math.max(0,taxable-taxableParts.basic-benefitTaxable);}
    else{
      taxableParts.other+=targetBeforeMandatory-classified;
      var reduction=mandatory,order=['basic','other','transportation','representation','cola','housing','commission','profitSharing','directorFees','hazard','overtime'];
      order.forEach(function(key){var applied=Math.min(Math.max(0,taxableParts[key]),reduction);taxableParts[key]-=applied;reduction-=applied;});
      var reconciled=Object.keys(taxableParts).reduce(function(s,key){return s+number(taxableParts[key]);},0);taxableParts.other+=taxable-reconciled;
    }
    Object.keys(taxableParts).forEach(function(key){taxableParts[key]=money(Math.max(0,taxableParts[key]));});
    var periodFrom=runs.reduce(function(v,r){var d=r.from||r.releaseDate||'';return !v||d<v?d:v;},''),periodTo=runs.reduce(function(v,r){var d=r.to||r.releaseDate||'';return !v||d>v?d:v;},'');
    return{
      year:year,periodFrom:datePart(periodFrom),periodTo:datePart(periodTo),employeeTin:clean(emp.tin),employeeName:employeeName(emp),employeeRdo:clean(emp.rdo).replace(/^RDO\s*/i,''),employeeAddress:clean(emp.permanentAddress||emp.city),employeeZip:clean(emp.zipCode||emp.zip),employeeLocalAddress:clean(emp.temporaryAddress||emp.permanentAddress||emp.city),employeeLocalZip:clean(emp.localZipCode||emp.zipCode||emp.zip),birthDate:fullDate(emp.bday),contact:clean(emp.contact),dailyMinimumWage:money(emp.minimumWageDaily),monthlyMinimumWage:money(emp.minimumWageMonthly),isMwe:!!emp.minimumWageEarner,
      employerTin:clean(company.taxIdentificationNo||company.tin),employerName:clean(company.registeredName||company.name),employerAddress:clean(company.registeredAddress||company.address),employerZip:clean(company.zipCode||company.zip),employerType:company.employerType||'main',
      previousTin:clean(profile.previousEmployerTin),previousName:clean(profile.previousEmployerName),previousAddress:clean(profile.previousEmployerAddress),previousZip:clean(profile.previousEmployerZip),
      grossPresent:gross,nonTaxablePresent:nonTaxable,taxablePresent:taxable,previousTaxable:previousTaxable,grossTaxable:totalTaxable,taxDue:taxDue,presentTax:presentTax,previousTax:previousTax,totalTaxWithheld:money(presentTax+previousTax),
      nonTaxBasic:0,holidayMwe:0,overtimeMwe:0,nightMwe:0,hazardMwe:0,benefitExempt:benefitExempt,deMinimis:deMinimis,mandatory:mandatory,otherNonTaxable:otherNonTaxable,totalNonTaxable:nonTaxable,
      taxableBasic:taxableParts.basic,taxableRepresentation:taxableParts.representation,taxableTransportation:taxableParts.transportation,taxableCola:taxableParts.cola,taxableHousing:taxableParts.housing,taxableCommission:taxableParts.commission,taxableProfitSharing:taxableParts.profitSharing,taxableDirectorFees:taxableParts.directorFees,taxableBenefit:taxableParts.benefit,taxableHazard:taxableParts.hazard,taxableOvertime:taxableParts.overtime,otherTaxable:taxableParts.other,totalTaxablePresent:taxable,authorizedAgent:clean(company.authorizedAgent),authorizedAgentTitle:clean(company.authorizedAgentTitle),runsCount:runs.length
    };
  }
  async function render(templateBytes,data,pdfLib){
    if(!pdfLib||!pdfLib.PDFDocument)throw new Error('PDF engine is unavailable.');
    var doc=await pdfLib.PDFDocument.load(templateBytes),page=doc.getPages()[0],font=await doc.embedFont(pdfLib.StandardFonts.Helvetica),bold=await doc.embedFont(pdfLib.StandardFonts.HelveticaBold),black=pdfLib.rgb(0,0,0);
    function fit(text,max,size){text=clean(text);while(text.length&&font.widthOfTextAtSize(text,size)>max)text=text.slice(0,-1);return text;}
    function draw(text,x,y,max,size,align,useBold){text=clean(text);if(!text)return;size=size||7;var f=useBold?bold:font,t=fit(text,max,size),w=f.widthOfTextAtSize(t,size);page.drawText(t,{x:align==='right'?x+max-w:align==='center'?x+(max-w)/2:x,y:y,size:size,font:f,color:black});}
    function drawCells(value,centers,y,size,useBold){
      var chars=clean(value).replace(/[^0-9A-Za-z]/g,'').split(''),f=useBold?bold:font;
      chars.slice(0,centers.length).forEach(function(char,index){var w=f.widthOfTextAtSize(char,size);page.drawText(char,{x:centers[index]-w/2,y:y,size:size,font:f,color:black});});
    }
    function amount(value,y){if(!number(value))return;draw(number(value).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2}),484,y,101,7,'right');}
    function summary(value,y){if(!number(value))return;draw(number(value).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2}),192,y,116,7,'right');}
    var yearCells=[133.6,151.3,168.9,186.6],periodFromCells=[395.6,413.0,430.4,447.8],periodToCells=[521.4,538.9,556.4,573.9];
    var tinCells=[92.3,104.9,117.5,142.1,154.7,167.4,191.6,204.2,216.9,242.3,256.5,270.7,284.9,299.1];
    var rdoCells=[270.8,283.4,296.1],zipCells=[266.2,278.3,290.4,302.5],birthCells=[52.9,65.5,78.1,90.7,103.3,115.9,128.5,141.1];
    var contactCells=[173.5,186.4,199.3,212.2,225.1,238.0,250.9,263.8,276.7,289.6,302.5];
    drawCells(data.year,yearCells,830,8,true);drawCells(data.periodFrom,periodFromCells,830,7,false);drawCells(data.periodTo,periodToCells,830,7,false);
    drawCells(data.employeeTin,tinCells,802,8,false);draw(data.employeeName,43,777,210,7);drawCells(data.employeeRdo,rdoCells,777,7,false);draw(data.employeeAddress,43,749,210,7);drawCells(data.employeeZip,zipCells,749,7,false);draw(data.employeeLocalAddress,43,724,210,7);drawCells(data.employeeLocalZip,zipCells,724,7,false);drawCells(data.birthDate,birthCells,671,7,false);drawCells(data.contact,contactCells,671,7,false);
    if(data.dailyMinimumWage)draw(data.dailyMinimumWage.toFixed(2),210,653,98,7,'right');if(data.monthlyMinimumWage)draw(data.monthlyMinimumWage.toFixed(2),210,635,98,7,'right');if(data.isMwe)draw('X',48,617,14,10,'center',true);
    drawCells(data.employerTin,tinCells,590,8,false);draw(data.employerName,43,564,264,7);draw(data.employerAddress,43,538,210,7);drawCells(data.employerZip,zipCells,538,7,false);draw('X',data.employerType==='secondary'?202:116,520,13,10,'center',true);
    drawCells(data.previousTin,tinCells,494,8,false);draw(data.previousName,43,468,264,7);draw(data.previousAddress,43,442,210,7);drawCells(data.previousZip,zipCells,442,7,false);
    summary(data.grossPresent,414);summary(data.nonTaxablePresent,394);summary(data.taxablePresent,375);summary(data.previousTaxable,356);summary(data.grossTaxable,336);summary(data.taxDue,317);summary(data.presentTax,297);summary(data.previousTax,278);summary(data.totalTaxWithheld,259);summary(data.totalTaxWithheld,219);
    amount(data.nonTaxBasic,784);amount(data.holidayMwe,766);amount(data.overtimeMwe,746);amount(data.nightMwe,726);amount(data.hazardMwe,706);amount(data.benefitExempt,687);amount(data.deMinimis,667);amount(data.mandatory,648);amount(data.otherNonTaxable,628);amount(data.totalNonTaxable,609);
    amount(data.taxableBasic,571);amount(data.taxableRepresentation,552);amount(data.taxableTransportation,532);amount(data.taxableCola,513);amount(data.taxableHousing,493);amount(data.taxableCommission,416);amount(data.taxableProfitSharing,397);amount(data.taxableDirectorFees,377);amount(data.taxableBenefit,363);amount(data.taxableHazard,339);amount(data.taxableOvertime,320);if(data.otherTaxable){draw('OTHER TAXABLE COMPENSATION',342,298,132,6);amount(data.otherTaxable,298);}amount(data.totalTaxablePresent,258);
    doc.setTitle('BIR Form 2316 - '+data.employeeName+' - '+data.year);doc.setSubject('Certificate of Compensation Payment/Tax Withheld');doc.setProducer('SproutRipple PH Payroll');
    return await doc.save();
  }
  return{money:money,buildData:buildData,render:render};
}));
