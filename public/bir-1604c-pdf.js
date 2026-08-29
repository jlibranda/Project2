/* BIR Form 1604-C (Annual Information Return of Income Taxes Withheld on Compensation) --
   system-generated summary document.

   Unlike BIR2316Pdf/BIR1601CPdf, this does NOT overlay a scanned copy of the official BIR
   template -- no fillable 1604-C PDF ships with this repo (public/forms/ only has the 1601-C
   and 2316 templates), and this environment's network egress is locked down enough that the
   official form couldn't be fetched at generation time either. Rather than guess at a scanned
   form's exact field coordinates without ever having seen it, this renders a clean, clearly-
   labeled, from-scratch PDF (via PDFDocument.create(), not .load()) that reports every figure
   BIR Form 1604-C requires -- withholding agent info, the annual summary, and the Jan-Dec
   monthly schedule -- computed from the exact same approved/locked payroll + released final pay
   data as the official 1601-C and 2316 PDFs, via BIR1604CCore.aggregateYear() (itself built on
   BIR1601CCore.aggregate()). It says as much on the page, and should be transcribed onto the
   actual BIR form (or eBIRForms) before filing, the same as every other worksheet/report this
   app produces. */
(function(root,factory){var api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BIR1604CPdf=api;}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function number(v){return Number(v)||0;}
  function money(v){return Math.round(number(v)*100)/100;}
  function clean(v){return String(v==null?'':v).replace(/\s+/g,' ').trim();}
  function fmt(v){return number(v).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});}

  function buildData(input){
    input=input||{};
    var company=input.company||{},year=Number(input.year)||new Date().getFullYear();
    var summary=input.summary||{};
    return{
      year:year,
      employerTin:clean(company.taxIdentificationNo||company.tin),
      employerRdo:clean(company.rdo),
      employerName:clean(company.registeredName||company.name),
      employerAddress:clean(company.registeredAddress||company.address),
      employerZip:clean(company.zipCode||company.zip),
      employeeCount:summary.employeeCount||0,
      totalCompensation:money(summary.totalCompensation),
      totalNonTaxable:money(summary.totalNonTaxable),
      taxableCompensation:money(summary.taxableCompensation),
      totalTaxesWithheld:money(summary.totalTaxesWithheld),
      annualizationRefunds:money(summary.annualizationRefunds),
      taxRequiredForRemittance:money(summary.taxRequiredForRemittance),
      months:(summary.months||[]).map(function(mo){return{monthName:mo.monthName,totalCompensation:money(mo.totalCompensation),taxableCompensation:money(mo.taxableCompensation),totalTaxesWithheld:money(mo.totalTaxesWithheld),taxRequiredForRemittance:money(mo.taxRequiredForRemittance)};}),
      authorizedAgent:clean(company.authorizedAgent),
      authorizedAgentTitle:clean(company.authorizedAgentTitle)
    };
  }

  async function render(data,pdfLib){
    if(!pdfLib||!pdfLib.PDFDocument)throw new Error('PDF engine is unavailable.');
    var doc=await pdfLib.PDFDocument.create();
    var page=doc.addPage([612,792]);
    var font=await doc.embedFont(pdfLib.StandardFonts.Helvetica);
    var bold=await doc.embedFont(pdfLib.StandardFonts.HelveticaBold);
    var black=pdfLib.rgb(0,0,0),gray=pdfLib.rgb(0.4,0.4,0.4),line=pdfLib.rgb(0.75,0.75,0.75);
    var M=42,W=612-M*2,y=792-M;

    function text(t,x,yy,size,useBold,color){page.drawText(clean(t),{x:x,y:yy,size:size||9,font:useBold?bold:font,color:color||black});}
    function rightText(t,xEnd,yy,size,useBold,color){var t2=clean(t),f=useBold?bold:font,s=size||9,w=f.widthOfTextAtSize(t2,s);page.drawText(t2,{x:xEnd-w,y:yy,size:s,font:f,color:color||black});}
    function hr(yy){page.drawLine({start:{x:M,y:yy},end:{x:M+W,y:yy},thickness:0.75,color:line});}
    // Greedy word-wrap for the free-text notice/declaration paragraphs -- returns the new y
    // after drawing every wrapped line, so callers don't have to guess a line count up front.
    function wrapped(t,x,yy,maxWidth,size,useBold,color){
      var f=useBold?bold:font,s=size||8,words=clean(t).split(' '),lines=[],cur='';
      words.forEach(function(word){
        var candidate=cur?cur+' '+word:word;
        if(f.widthOfTextAtSize(candidate,s)>maxWidth&&cur){lines.push(cur);cur=word;}else cur=candidate;
      });
      if(cur)lines.push(cur);
      lines.forEach(function(ln,i){page.drawText(ln,{x:x,y:yy-i*(s+2.5),size:s,font:f,color:color||black});});
      return yy-lines.length*(s+2.5);
    }

    text('Republic of the Philippines · Department of Finance · Bureau of Internal Revenue',M,y,8,false,gray); y-=16;
    text('BIR FORM No. 1604-C',M,y,15,true); y-=18;
    text('Annual Information Return of Income Taxes Withheld on Compensation',M,y,11,true); y-=14;
    text('For the Year '+data.year,M,y,10,false,gray); y-=10;
    hr(y); y-=16;
    y=wrapped('System-generated summary -- reports the figures BIR Form 1604-C requires, computed from approved/locked payroll and released final pay for the year. Review and transcribe onto the official BIR form (or eBIRForms) before filing; this is not a scanned copy of the government template.',M,y,W,7.5,false,gray); y-=3;
    y=wrapped('Every amount below traces to the same approved/locked payroll runs and released final pay used by this system’s official BIR 1601-C and 2316 PDFs.',M,y,W,7.5,false,gray); y-=14;

    text('PART I -- WITHHOLDING AGENT (EMPLOYER) INFORMATION',M,y,10,true); y-=16;
    text('TIN',M,y,8,false,gray); text(data.employerTin||'—',M,y-11,9.5,true);
    text('RDO Code',M+150,y,8,false,gray); text(data.employerRdo||'—',M+150,y-11,9.5,true);
    text('Tax Year',M+300,y,8,false,gray); text(String(data.year),M+300,y-11,9.5,true); y-=32;
    text('Registered Name',M,y,8,false,gray); text(data.employerName||'—',M,y-11,9.5,true); y-=32;
    text('Registered Address',M,y,8,false,gray); text((data.employerAddress||'—')+(data.employerZip?'  '+data.employerZip:''),M,y-11,9.5,true); y-=34;
    hr(y); y-=18;

    text('PART II -- ANNUAL SUMMARY',M,y,10,true); y-=18;
    var sRows=[
      ['Number of Employees with Income Taxes Withheld',String(data.employeeCount)],
      ['Total Amount of Compensation Paid for the Year',fmt(data.totalCompensation)],
      ['Total Non-Taxable / Exempt Compensation',fmt(data.totalNonTaxable)],
      ['Total Taxable Compensation',fmt(data.taxableCompensation)],
      ['Total Taxes Withheld for the Year',fmt(data.totalTaxesWithheld)],
      ['Tax Refunded to Employees (Annualization)',fmt(data.annualizationRefunds)],
      ['Total Tax Required to be Remitted for the Year',fmt(data.taxRequiredForRemittance)]
    ];
    sRows.forEach(function(row,i){
      var ry=y-(i*15.5);
      text(row[0],M,ry,8.5);
      rightText(row[1],M+W,ry,8.5,i===sRows.length-1,i===sRows.length-1?black:undefined);
    });
    y-=sRows.length*15.5+16;
    hr(y); y-=18;

    text('PART III -- MONTHLY SCHEDULE OF COMPENSATION AND TAX WITHHELD',M,y,10,true); y-=16;
    // Column right-edges, evenly spaced across the full page width (M+W = 570) so headers and
    // 6-7 digit peso amounts never collide, however wide the longest header label turns out.
    var colEnd={comp:M+140,taxable:M+260,tax:M+385,remit:M+W};
    text('Month',M,y,8,true); rightText('Compensation',colEnd.comp,y,8,true); rightText('Taxable Comp.',colEnd.taxable,y,8,true); rightText('Tax Withheld',colEnd.tax,y,8,true); rightText('Net Remitted',colEnd.remit,y,8,true);
    y-=6; hr(y); y-=12;
    data.months.forEach(function(mo){
      text(mo.monthName,M,y,8.5);
      rightText(fmt(mo.totalCompensation),colEnd.comp,y,8.5);
      rightText(fmt(mo.taxableCompensation),colEnd.taxable,y,8.5);
      rightText(fmt(mo.totalTaxesWithheld),colEnd.tax,y,8.5);
      rightText(fmt(mo.taxRequiredForRemittance),colEnd.remit,y,8.5);
      y-=14;
    });
    y-=2; hr(y); y-=13;
    text('TOTAL',M,y,8.5,true);
    rightText(fmt(data.totalCompensation),colEnd.comp,y,8.5,true);
    rightText(fmt(data.taxableCompensation),colEnd.taxable,y,8.5,true);
    rightText(fmt(data.totalTaxesWithheld),colEnd.tax,y,8.5,true);
    rightText(fmt(data.taxRequiredForRemittance),colEnd.remit,y,8.5,true);
    y-=30; hr(y); y-=24;

    y=wrapped('I/We declare, under the penalties of perjury, that this return has been made in good faith, verified by me/us, and to the best of my/our knowledge and belief, is true and correct, pursuant to the provisions of the National Internal Revenue Code, as amended, and the regulations issued under authority thereof.',M,y,W,7.5,false,gray);
    y-=32;
    page.drawLine({start:{x:M,y:y},end:{x:M+220,y:y},thickness:0.75,color:line});
    text(data.authorizedAgent||'Authorized Agent / Signatory over Printed Name',M,y-12,8);
    text(data.authorizedAgentTitle||'Title',M,y-24,7.5,false,gray);
    text('Date Signed',M+330,y-12,8,false,gray);
    page.drawLine({start:{x:M+330,y:y-16},end:{x:M+330+120,y:y-16},thickness:0.75,color:line});

    doc.setTitle('BIR Form 1604-C - '+data.employerName+' - '+data.year);
    doc.setSubject('Annual Information Return of Income Taxes Withheld on Compensation');
    doc.setProducer('SproutRipple PH Payroll');
    return await doc.save();
  }

  return{money:money,buildData:buildData,render:render};
}));
