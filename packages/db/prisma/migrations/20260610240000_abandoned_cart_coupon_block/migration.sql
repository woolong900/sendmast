-- Abandoned cart: add the {{coupon_block}} slot above the CTA. System renders
-- the coupon card into it per round; empty (hidden) when no coupon is chosen.
UPDATE "email_templates"
SET
  "mjml" = $mjml$
          <mjml>
          <mj-head>
              
    <mj-html-attributes>
      <mj-html-attribute class="easy-email" multiple-attributes="false" attribute-name="text-color" text-color="#111827"></mj-html-attribute>
<mj-html-attribute class="easy-email" multiple-attributes="false" attribute-name="font-family" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif"></mj-html-attribute>
<mj-html-attribute class="easy-email" multiple-attributes="false" attribute-name="font-size" font-size="14px"></mj-html-attribute>
<mj-html-attribute class="easy-email" multiple-attributes="false" attribute-name="line-height" line-height="1.7"></mj-html-attribute>
<mj-html-attribute class="easy-email" multiple-attributes="false" attribute-name="font-weight" font-weight="400"></mj-html-attribute>
<mj-html-attribute class="easy-email" multiple-attributes="false" attribute-name="responsive" responsive="true"></mj-html-attribute>

    </mj-html-attributes>
  
              
              
              
              <mj-breakpoint width="480px" />
              
              
            <mj-attributes>
              
              <mj-all font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif" />
              <mj-text font-size="14px" />
              <mj-text color="#111827" />
        <mj-text line-height="1.7" />
        <mj-text font-weight="400" />
              

            </mj-attributes>
          </mj-head>
          <mj-body background-color="#f4f4f5" width="600px" ><mj-section padding="40px 0 16px" border="none" direction="ltr" text-align="center" background-repeat="repeat" background-size="auto" background-position="top center" background-color="#f4f4f5" ><mj-column padding="0px 0px 0px 0px" border="none" vertical-align="top" width="100%" ><mj-text padding="0 20px" align="left" font-size="26px" color="#111827" >{{shop_name}}</mj-text></mj-column></mj-section><mj-section padding="0 20px 20px" background-repeat="repeat" background-size="auto" background-position="top center" border="none" direction="ltr" text-align="center" background-color="#f4f4f5" ><mj-column padding="36px 32px" border="none" vertical-align="top" width="100%" background-color="#ffffff" border-radius="10px" ><mj-text padding="0 0 12px" align="left" font-size="24px" color="#111827" font-weight="600" >You left items in your cart</mj-text><mj-text padding="0 0 20px" align="left" font-size="16px" color="#555555" line-height="1.6" >Hi {{full_name}}, you added items to your shopping cart but haven't completed your purchase yet. Complete it now while they're still available.</mj-text><mj-text padding="0 0 8px" align="left" font-size="14px" color="#6b7280" font-weight="600" >Items in your cart</mj-text><mj-raw >{{order_items}}</mj-raw><mj-raw >{{coupon_block}}</mj-raw><mj-button align="center" background-color="#111827" color="#ffffff" font-weight="600" border-radius="6px" padding="16px 34px" inner-padding="10px 25px 10px 25px" line-height="120%" target="_blank" vertical-align="middle" border="none" text-align="center" href="{{tracking_url}}" font-size="16px" width="100%" >Complete your purchase</mj-button></mj-column></mj-section><mj-section padding="8px 0 28px" background-repeat="repeat" background-size="auto" background-position="top center" border="none" direction="ltr" text-align="center" background-color="#f4f4f5" ><mj-column padding="0px 0px 0px 0px" border="none" vertical-align="top" width="100%" ><mj-text padding="0 20px" align="center" font-size="13px" color="#9ca3af" line-height="1.6" >Don't want to receive cart reminders? <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml > $mjml$,
  "html" = $html$<!doctype html>
<html lang="und" dir="auto" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <title></title>
    <!--[if !mso]><!-->
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <!--<![endif]-->
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style type="text/css">
      #outlook a { padding:0; }
      body { margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%; }
      table, td { border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt; }
      img { border:0;height:auto;line-height:100%; outline:none;text-decoration:none;-ms-interpolation-mode:bicubic; }
      p { display:block;margin:13px 0; }
    </style>
    <!--[if mso]>
    <noscript>
    <xml>
    <o:OfficeDocumentSettings>
      <o:AllowPNG/>
      <o:PixelsPerInch>96</o:PixelsPerInch>
    </o:OfficeDocumentSettings>
    </xml>
    </noscript>
    <![endif]-->
    <!--[if lte mso 11]>
    <style type="text/css">
      .mj-outlook-group-fix { width:100% !important; }
    </style>
    <![endif]-->
    
      <!--[if !mso]><!-->
        <link href="https://fonts.googleapis.com/css?family=Roboto:300,400,500,700" rel="stylesheet" type="text/css">
        <style type="text/css">
          @import url(https://fonts.googleapis.com/css?family=Roboto:300,400,500,700);
        </style>
      <!--<![endif]-->

    
    
    <style type="text/css">
      @media only screen and (min-width:480px) {
        .mj-column-per-100 { width:100% !important; max-width: 100%; }
      }
    </style>
    <style media="screen and (min-width:480px)">
      .moz-text-html .mj-column-per-100 { width:100% !important; max-width: 100%; }
    </style>
    
    
  
    
    
    
  </head>
  <body style="word-spacing:normal;background-color:#f4f4f5;">
    
    
      <div
         aria-roledescription="email" style="background-color:#f4f4f5;" role="article" lang="und" dir="auto"
      >
        
      
      <!--[if mso | IE]><table align="center" border="0" cellpadding="0" cellspacing="0" class="" role="presentation" style="width:600px;" width="600" bgcolor="#f4f4f5" ><tr><td style="line-height:0px;font-size:0px;mso-line-height-rule:exactly;"><![endif]-->
    
      
      <div  style="background:#f4f4f5;background-color:#f4f4f5;margin:0px auto;max-width:600px;">
        
        <table
           align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f4f5;background-color:#f4f4f5;width:100%;"
        >
          <tbody>
            <tr>
              <td
                 style="border:none;direction:ltr;font-size:0px;padding:40px 0 16px;text-align:center;"
              >
                <!--[if mso | IE]><table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr><td class="" style="vertical-align:top;width:600px;" ><![endif]-->
            
      <div
         class="mj-column-per-100 mj-outlook-group-fix" style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;"
      >
        
      <table
         border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"
      >
        <tbody>
          <tr>
            <td  style="border:none;vertical-align:top;padding:0px 0px 0px 0px;">
              
      <table
         border="0" cellpadding="0" cellspacing="0" role="presentation" style="" width="100%"
      >
        <tbody>
          
              <tr>
                <td
                   align="left" style="font-size:0px;padding:0 20px;word-break:break-word;"
                >
                  
      <div
         style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:26px;font-weight:400;line-height:1.7;text-align:left;color:#111827;"
      >{{shop_name}}</div>
    
                </td>
              </tr>
            
        </tbody>
      </table>
    
            </td>
          </tr>
        </tbody>
      </table>
    
      </div>
    
          <!--[if mso | IE]></td></tr></table><![endif]-->
              </td>
            </tr>
          </tbody>
        </table>
        
      </div>
    
      
      <!--[if mso | IE]></td></tr></table><table align="center" border="0" cellpadding="0" cellspacing="0" class="" role="presentation" style="width:600px;" width="600" bgcolor="#f4f4f5" ><tr><td style="line-height:0px;font-size:0px;mso-line-height-rule:exactly;"><![endif]-->
    
      
      <div  style="background:#f4f4f5;background-color:#f4f4f5;margin:0px auto;max-width:600px;">
        
        <table
           align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f4f5;background-color:#f4f4f5;width:100%;"
        >
          <tbody>
            <tr>
              <td
                 style="border:none;direction:ltr;font-size:0px;padding:0 20px 20px;text-align:center;"
              >
                <!--[if mso | IE]><table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr><td class="" style="vertical-align:top;width:560px;" ><![endif]-->
            
      <div
         class="mj-column-per-100 mj-outlook-group-fix" style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;"
      >
        
      <table
         border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="border-collapse:separate;"
      >
        <tbody>
          <tr>
            <td  style="background-color:#ffffff;border:none;border-radius:10px;vertical-align:top;border-collapse:separate;padding:36px 32px;">
              
      <table
         border="0" cellpadding="0" cellspacing="0" role="presentation" style="" width="100%"
      >
        <tbody>
          
              <tr>
                <td
                   align="left" style="font-size:0px;padding:0 0 12px;word-break:break-word;"
                >
                  
      <div
         style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:24px;font-weight:600;line-height:1.7;text-align:left;color:#111827;"
      >You left items in your cart</div>
    
                </td>
              </tr>
            
              <tr>
                <td
                   align="left" style="font-size:0px;padding:0 0 20px;word-break:break-word;"
                >
                  
      <div
         style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:16px;font-weight:400;line-height:1.6;text-align:left;color:#555555;"
      >Hi {{full_name}}, you added items to your shopping cart but haven't completed your purchase yet. Complete it now while they're still available.</div>
    
                </td>
              </tr>
            
              <tr>
                <td
                   align="left" style="font-size:0px;padding:0 0 8px;word-break:break-word;"
                >
                  
      <div
         style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:14px;font-weight:600;line-height:1.7;text-align:left;color:#6b7280;"
      >Items in your cart</div>
    
                </td>
              </tr>
            {{order_items}}{{coupon_block}}
              <tr>
                <td
                   align="center" style="font-size:0px;padding:16px 34px;word-break:break-word;"
                >
                  
      <table
         border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate;width:100%;line-height:100%;"
      >
        <tbody>
          <tr>
            <td
               align="center" bgcolor="#111827" role="presentation" style="border:none;border-radius:6px;cursor:auto;mso-padding-alt:10px 25px 10px 25px;text-align:center;background:#111827;" valign="middle"
            >
              <a
                 href="{{tracking_url}}" style="display:inline-block;background:#111827;color:#ffffff;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:16px;font-weight:600;line-height:120%;margin:0;text-decoration:none;text-transform:none;padding:10px 25px 10px 25px;mso-padding-alt:0px;border-radius:6px;" target="_blank"
              >
                Complete your purchase
              </a>
            </td>
          </tr>
        </tbody>
      </table>
    
                </td>
              </tr>
            
        </tbody>
      </table>
    
            </td>
          </tr>
        </tbody>
      </table>
    
      </div>
    
          <!--[if mso | IE]></td></tr></table><![endif]-->
              </td>
            </tr>
          </tbody>
        </table>
        
      </div>
    
      
      <!--[if mso | IE]></td></tr></table><table align="center" border="0" cellpadding="0" cellspacing="0" class="" role="presentation" style="width:600px;" width="600" bgcolor="#f4f4f5" ><tr><td style="line-height:0px;font-size:0px;mso-line-height-rule:exactly;"><![endif]-->
    
      
      <div  style="background:#f4f4f5;background-color:#f4f4f5;margin:0px auto;max-width:600px;">
        
        <table
           align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f4f5;background-color:#f4f4f5;width:100%;"
        >
          <tbody>
            <tr>
              <td
                 style="border:none;direction:ltr;font-size:0px;padding:8px 0 28px;text-align:center;"
              >
                <!--[if mso | IE]><table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr><td class="" style="vertical-align:top;width:600px;" ><![endif]-->
            
      <div
         class="mj-column-per-100 mj-outlook-group-fix" style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;"
      >
        
      <table
         border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"
      >
        <tbody>
          <tr>
            <td  style="border:none;vertical-align:top;padding:0px 0px 0px 0px;">
              
      <table
         border="0" cellpadding="0" cellspacing="0" role="presentation" style="" width="100%"
      >
        <tbody>
          
              <tr>
                <td
                   align="center" style="font-size:0px;padding:0 20px;word-break:break-word;"
                >
                  
      <div
         style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:13px;font-weight:400;line-height:1.6;text-align:center;color:#9ca3af;"
      >Don't want to receive cart reminders? <a href="{{unsubscribe_url}}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a></div>
    
                </td>
              </tr>
            
        </tbody>
      </table>
    
            </td>
          </tr>
        </tbody>
      </table>
    
      </div>
    
          <!--[if mso | IE]></td></tr></table><![endif]-->
              </td>
            </tr>
          </tbody>
        </table>
        
      </div>
    
      
      <!--[if mso | IE]></td></tr></table><![endif]-->
    
    
      </div>
    
  </body>
</html>
  $html$,
  "design_json" = $json${"subject":"Complete your purchase","subTitle":"","content":{"type":"page","data":{"value":{"breakpoint":"480px","headAttributes":"","font-size":"14px","font-weight":"400","line-height":"1.7","headStyles":[],"fonts":[],"responsive":true,"font-family":"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif","text-color":"#111827"}},"attributes":{"background-color":"#f4f4f5","width":"600px"},"children":[{"type":"section","data":{"value":{"noWrap":false}},"attributes":{"padding":"40px 0 16px","border":"none","direction":"ltr","text-align":"center","background-repeat":"repeat","background-size":"auto","background-position":"top center","background-color":"#f4f4f5"},"children":[{"type":"column","data":{"value":{}},"attributes":{"padding":"0px 0px 0px 0px","border":"none","vertical-align":"top","width":"100%"},"children":[{"type":"advanced_text","data":{"value":{"content":"{{shop_name}}"}},"attributes":{"padding":"0 20px","align":"left","font-size":"26px","color":"#111827"},"children":[]}]}]},{"type":"section","data":{"value":{"noWrap":false}},"attributes":{"padding":"0 20px 20px","background-repeat":"repeat","background-size":"auto","background-position":"top center","border":"none","direction":"ltr","text-align":"center","background-color":"#f4f4f5"},"children":[{"type":"column","data":{"value":{}},"attributes":{"padding":"36px 32px","border":"none","vertical-align":"top","width":"100%","background-color":"#ffffff","border-radius":"10px"},"children":[{"type":"advanced_text","data":{"value":{"content":"You left items in your cart"}},"attributes":{"padding":"0 0 12px","align":"left","font-size":"24px","color":"#111827","font-weight":"600"},"children":[]},{"type":"advanced_text","data":{"value":{"content":"Hi {{full_name}}, you added items to your shopping cart but haven't completed your purchase yet. Complete it now while they're still available."}},"attributes":{"padding":"0 0 20px","align":"left","font-size":"16px","color":"#555555","line-height":"1.6"},"children":[]},{"type":"advanced_text","data":{"value":{"content":"Items in your cart"}},"attributes":{"padding":"0 0 8px","align":"left","font-size":"14px","color":"#6b7280","font-weight":"600"},"children":[]},{"type":"raw","data":{"value":{"content":"{{order_items}}"}},"attributes":{},"children":[]},{"type":"raw","data":{"value":{"content":"{{coupon_block}}"}},"attributes":{},"children":[]},{"type":"advanced_button","data":{"value":{"content":"Complete your purchase"}},"attributes":{"align":"center","background-color":"#111827","color":"#ffffff","font-weight":"600","border-radius":"6px","padding":"16px 34px","inner-padding":"10px 25px 10px 25px","line-height":"120%","target":"_blank","vertical-align":"middle","border":"none","text-align":"center","href":"{{tracking_url}}","font-size":"16px","width":"100%"},"children":[]}]}]},{"type":"section","data":{"value":{"noWrap":false}},"attributes":{"padding":"8px 0 28px","background-repeat":"repeat","background-size":"auto","background-position":"top center","border":"none","direction":"ltr","text-align":"center","background-color":"#f4f4f5"},"children":[{"type":"column","data":{"value":{}},"attributes":{"padding":"0px 0px 0px 0px","border":"none","vertical-align":"top","width":"100%"},"children":[{"type":"advanced_text","data":{"value":{"content":"Don't want to receive cart reminders? <a href=\"{{unsubscribe_url}}\" style=\"color:#9ca3af;text-decoration:underline;\">Unsubscribe</a>"}},"attributes":{"padding":"0 20px","align":"center","font-size":"13px","color":"#9ca3af","line-height":"1.6"},"children":[]}]}]}]}}$json$::jsonb,
  "updated_at" = now()
WHERE "id" = '00000000-0000-4000-8000-000000000004';
