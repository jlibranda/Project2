/* BIR Form 1601-C January 2018 (ENCS) data mapping and official PDF overlay. */
(function(root,factory){var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BIR1601CPdf=api;}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function number(value){return Number(value)||0;}
  function money(value){return Math.round(number(value)*100)/100;}
  function clean(value){return String(value==null?'':value).replace(/\s+/g,' ').trim();}
  function normalizeRdo(value){
    var code=clean(value).toUpperCase().replace(/^RDO[\s-]*/,'').replace(/[^0-9A-Z]/g,'');
    if(/^\d{1,3}$/.test(code))return code.padStart(3,'0');
    if(/^\d{1,2}[A-Z]$/.test(code))return code.padStart(3,'0');
    return code.slice(0,3);
  }
  function buildData(input){
    input=input||{};var company=input.company||{},report=input.report||{},month=String(input.month||report.month||'');
    var parts=/^(\d{4})-(\d{2})$/.exec(month)||[];
    var withheld=money(report.totalTaxesWithheld),adjustment=money(input.priorMonthAdjustment!=null?input.priorMonthAdjustment:-number(report.annualizationRefunds));
    var item27=money(Math.max(0,withheld+adjustment)),item28=money(input.previouslyRemitted),item29=money(input.otherRemittances),item30=money(item28+item29),item31=money(item27-item30);
    var surcharge=money(input.surcharge),interest=money(input.interest),compromise=money(input.compromise),penalties=money(surcharge+interest+compromise);
    return{
      month:(parts[2]||'')+(parts[1]||''),monthLabel:(parts[2]||'')+'/'+(parts[1]||''),amended:!!input.amended,sheetsAttached:clean(input.sheetsAttached||''),atc:'WW010',
      tin:clean(company.taxIdentificationNo||company.tin),rdo:normalizeRdo(company.rdo),name:clean(company.registeredName||company.name).toUpperCase(),address:clean(company.registeredAddress||company.address).toUpperCase(),zip:clean(company.zipCode||company.zip),contact:clean(company.contactNumber||company.contact),email:clean(company.emailAddress||company.email).toUpperCase(),category:company.withholdingAgentCategory==='government'?'government':'private',taxRelief:!!company.taxRelief,taxReliefDetails:clean(company.taxReliefDetails).toUpperCase(),
      item14:money(report.totalCompensation),item15:money(report.minimumWageCompensation),item16:money(report.mwePremiumCompensation),item17:money(report.annualBenefitExempt),item18:money(report.deMinimis),item19:money(report.mandatoryContributions),item20:money(report.otherNonTaxable),item21:money(report.totalNonTaxable),item22:money(report.taxableCompensation),item23:money(report.taxableNotSubjectToWithholding),item24:money(Math.max(0,number(report.taxableCompensation)-number(report.taxableNotSubjectToWithholding))),item25:withheld,item26:adjustment,item27:item27,item28:item28,item29:item29,item30:item30,item31:item31,item32:surcharge,item33:interest,item34:compromise,item35:penalties,item36:money(item31+penalties),
      hasTaxes:withheld!==0||item27!==0,authorizedAgent:clean(company.authorizedAgent).toUpperCase(),authorizedAgentTitle:clean(company.authorizedAgentTitle).toUpperCase()
    };
  }
  async function render(templateBytes,data,pdfLib){
    if(!pdfLib||!pdfLib.PDFDocument)throw new Error('PDF engine is unavailable.');
    var doc=await pdfLib.PDFDocument.load(templateBytes),pages=doc.getPages(),page=pages[0],page2=pages[1],font=await doc.embedFont(pdfLib.StandardFonts.Helvetica),bold=await doc.embedFont(pdfLib.StandardFonts.HelveticaBold),black=pdfLib.rgb(0,0,0);
    function ascii(value){return clean(value).normalize('NFKD').replace(/[^\x20-\x7E]/g,'');}
    function draw(text,x,y,max,size,align,useBold,target){text=ascii(text);if(!text)return;target=target||page;size=size||7;var f=useBold?bold:font;while(text.length&&f.widthOfTextAtSize(text,size)>max)text=text.slice(0,-1);var w=f.widthOfTextAtSize(text,size);target.drawText(text,{x:align==='right'?x+max-w:align==='center'?x+(max-w)/2:x,y:y,size:size,font:f,color:black});}
    function drawCells(value,centers,y,size,target){var chars=ascii(value).replace(/[^0-9A-Za-z]/g,'').split('');target=target||page;chars.slice(0,centers.length).forEach(function(char,index){var w=font.widthOfTextAtSize(char,size);target.drawText(char,{x:centers[index]-w/2,y:y,size:size,font:font,color:black});});}
    function repeatedCenters(start,width,count){return Array.from({length:count},function(_,index){return start+width*(index+.5);});}
    function drawTextCells(value,start,width,count,y,target){var chars=ascii(value).split('');target=target||page;chars.slice(0,count).forEach(function(char,index){if(char===' ')return;var w=font.widthOfTextAtSize(char,7);target.drawText(char,{x:start+width*(index+.5)-w/2,y:y,size:7,font:font,color:black});});}
    function mark(x,y,target){draw('X',x-6,y-4,12,10,'center',true,target);}
    var amountWhole=[397.9,412.3,426.7,441.1,455.3,469.4,483.8,498.2,512.6,527.0,541.4],amountCents=[571.7,586.8];
    function amount(value,y,target,wholeCenters,centCenters){
      if(value==null||value===''||number(value)===0)return;target=target||page;wholeCenters=wholeCenters||amountWhole;centCenters=centCenters||amountCents;var negative=number(value)<0,absolute=Math.abs(money(value)),parts=absolute.toFixed(2).split('.'),whole=parts[0].split('').slice(-wholeCenters.length),start=wholeCenters.length-whole.length;
      whole.forEach(function(char,index){drawCells(char,[wholeCenters[start+index]],y,7,target);});drawCells(parts[1],centCenters,y,7,target);if(negative)draw('-',wholeCenters[0]-9,y,7,7,'center',true,target);
    }
    var monthCells=[53.5,67.7,82.1,96.5,110.9,125.0];
    var tinCells=[240.5,254.9,269.0,298.1,312.2,326.4,355.4,369.6,384.0,412.8,426.9,441.1,455.5,469.9];
    var rdoCells=[555.8,571.2,586.6];
    drawCells(data.month,monthCells,813.8,8);mark(data.amended?190.1:238.2,817.1);mark(data.hasTaxes?311.0:351.4,817.1);draw(data.sheetsAttached,448,813.8,55,8,'center');
    drawCells(data.tin,tinCells,783.7,8);drawCells(data.rdo,rdoCells,783.7,8);
    drawTextCells(data.name,17.8,14.42,40,757.2);var address=ascii(data.address).toUpperCase();drawTextCells(address.slice(0,40),17.8,14.42,40,730.9);drawTextCells(address.slice(40),17.8,14.42,31,715.2);drawCells(data.zip,[541.5,556.0,570.4,584.9],715.2,7);
    drawTextCells(data.contact,104.2,14.42,12,698.1);mark(data.category==='government'?526.6:454.0,701.0);drawTextCells(data.email,104.2,14.42,34,681.0);mark(data.taxRelief?181.9:225.1,666.3);if(data.taxRelief)drawTextCells(data.taxReliefDetails,346.5,14.42,17,663.4);
    var ys={14:632.2,15:606.3,16:590.3,17:574.4,18:558.5,19:542.5,20:526.6,21:510.6,22:494.7,23:478.6,24:462.6,25:446.7,26:430.7,27:414.7,28:398.8,29:382.9,30:366.6,31:350.3,32:334.4,33:318.5,34:302.5,35:286.6,36:270.6};Object.keys(ys).forEach(function(key){amount(data['item'+key],ys[key]);});
    if(page2){drawCells(data.tin,repeatedCenters(17.8,14.42,14),832.6,8,page2);drawTextCells(data.name,218.4,14.42,26,832.9,page2);if(number(data.item26))amount(data.item26,639.5,page2,[337.9,352.3,366.7,381.1,395.3,409.4,423.8,438.2,452.6,467.0,481.4],[511.7,526.8]);}
    doc.setTitle('BIR Form 1601-C - '+data.monthLabel);doc.setSubject('Monthly Remittance Return of Income Taxes Withheld on Compensation');doc.setProducer('SproutRipple PH Payroll');return await doc.save();
  }
  return{money:money,normalizeRdo:normalizeRdo,buildData:buildData,render:render};
}));
