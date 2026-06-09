/** System default orderConfirmation template — block-based easy-email designJson. */
export const ORDER_CONFIRMATION_TEMPLATE_ID = "00000000-0000-4000-8000-000000000005";
export const ORDER_CONFIRMATION_SUBJECT = "Your order is confirmed";

export const orderConfirmationDesignJson = {
  "subject": "Your order is confirmed",
  "subTitle": "",
  "content": {
    "type": "page",
    "data": {
      "value": {
        "breakpoint": "480px",
        "headAttributes": "",
        "font-size": "14px",
        "font-weight": "400",
        "line-height": "1.7",
        "headStyles": [],
        "fonts": [],
        "responsive": true,
        "font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif",
        "text-color": "#111827"
      }
    },
    "attributes": {
      "background-color": "#f4f4f5",
      "width": "600px"
    },
    "children": [
      {
        "type": "section",
        "data": {
          "value": {
            "noWrap": false
          }
        },
        "attributes": {
          "padding": "40px 0 16px",
          "border": "none",
          "direction": "ltr",
          "text-align": "center",
          "background-repeat": "repeat",
          "background-size": "auto",
          "background-position": "top center",
          "background-color": "#f4f4f5"
        },
        "children": [
          {
            "type": "column",
            "data": {
              "value": {}
            },
            "attributes": {
              "padding": "0px 0px 0px 0px",
              "border": "none",
              "vertical-align": "top",
              "width": "100%"
            },
            "children": [
              {
                "type": "advanced_text",
                "data": {
                  "value": {
                    "content": "{{shop_name}}"
                  }
                },
                "attributes": {
                  "padding": "0 20px",
                  "align": "left",
                  "font-size": "26px",
                  "color": "#111827"
                },
                "children": []
              }
            ]
          }
        ]
      },
      {
        "type": "section",
        "data": {
          "value": {
            "noWrap": false
          }
        },
        "attributes": {
          "padding": "0 20px 20px",
          "background-repeat": "repeat",
          "background-size": "auto",
          "background-position": "top center",
          "border": "none",
          "direction": "ltr",
          "text-align": "center",
          "background-color": "#f4f4f5"
        },
        "children": [
          {
            "type": "column",
            "data": {
              "value": {}
            },
            "attributes": {
              "padding": "36px 32px",
              "border": "none",
              "vertical-align": "top",
              "width": "100%",
              "background-color": "#ffffff",
              "border-radius": "10px"
            },
            "children": [
              {
                "type": "advanced_text",
                "data": {
                  "value": {
                    "content": "Thank you for your order!"
                  }
                },
                "attributes": {
                  "padding": "0 0 12px",
                  "align": "left",
                  "font-size": "24px",
                  "color": "#111827",
                  "font-weight": "600"
                },
                "children": []
              },
              {
                "type": "advanced_text",
                "data": {
                  "value": {
                    "content": "Hi {{full_name}}, we've received your order and it's now being processed. Here's a summary of your purchase."
                  }
                },
                "attributes": {
                  "padding": "0 0 20px",
                  "align": "left",
                  "font-size": "16px",
                  "color": "#555555",
                  "line-height": "1.6"
                },
                "children": []
              },
              {
                "type": "advanced_text",
                "data": {
                  "value": {
                    "content": "Items"
                  }
                },
                "attributes": {
                  "padding": "0 0 8px",
                  "align": "left",
                  "font-size": "14px",
                  "color": "#6b7280",
                  "font-weight": "600"
                },
                "children": []
              },
              {
                "type": "raw",
                "data": {
                  "value": {
                    "content": "{{order_items}}"
                  }
                },
                "attributes": {},
                "children": []
              },
              {
                "type": "advanced_divider",
                "data": {
                  "value": {}
                },
                "attributes": {
                  "align": "center",
                  "border-width": "1px",
                  "border-style": "solid",
                  "border-color": "#eceff3",
                  "padding": "8px 0 16px"
                },
                "children": []
              },
              {
                "type": "advanced_text",
                "data": {
                  "value": {
                    "content": "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-spacing:0;border-collapse:collapse;background:#f9fafb;border:1px solid #eceff3;border-radius:8px;\"><tr><td style=\"padding:14px 18px;font-size:14px;color:#6b7280;\">Order</td><td align=\"right\" style=\"padding:14px 18px;font-size:14px;color:#111827;font-weight:600;\">{{order_no}}</td></tr></table>"
                  }
                },
                "attributes": {
                  "padding": "0 0 20px",
                  "align": "left",
                  "font-size": "14px",
                  "color": "#111827",
                  "line-height": "1.8"
                },
                "children": []
              }
            ]
          }
        ]
      },
      {
        "type": "section",
        "data": {
          "value": {
            "noWrap": false
          }
        },
        "attributes": {
          "padding": "8px 0 28px",
          "background-repeat": "repeat",
          "background-size": "auto",
          "background-position": "top center",
          "border": "none",
          "direction": "ltr",
          "text-align": "center",
          "background-color": "#f4f4f5"
        },
        "children": [
          {
            "type": "column",
            "data": {
              "value": {}
            },
            "attributes": {
              "padding": "0px 0px 0px 0px",
              "border": "none",
              "vertical-align": "top",
              "width": "100%"
            },
            "children": [
              {
                "type": "advanced_text",
                "data": {
                  "value": {
                    "content": "You received this email because you placed an order with us. <a href=\"{{unsubscribe_url}}\" style=\"color:#9ca3af;text-decoration:underline;\">Unsubscribe</a>"
                  }
                },
                "attributes": {
                  "padding": "0 20px",
                  "align": "center",
                  "font-size": "13px",
                  "color": "#9ca3af",
                  "line-height": "1.6"
                },
                "children": []
              }
            ]
          }
        ]
      }
    ]
  }
} as const;

export const orderConfirmationMjml = "\n          <mjml>\n          <mj-head>\n              \n    <mj-html-attributes>\n      <mj-html-attribute class=\"easy-email\" multiple-attributes=\"false\" attribute-name=\"text-color\" text-color=\"#111827\"></mj-html-attribute>\n<mj-html-attribute class=\"easy-email\" multiple-attributes=\"false\" attribute-name=\"font-family\" font-family=\"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif\"></mj-html-attribute>\n<mj-html-attribute class=\"easy-email\" multiple-attributes=\"false\" attribute-name=\"font-size\" font-size=\"14px\"></mj-html-attribute>\n<mj-html-attribute class=\"easy-email\" multiple-attributes=\"false\" attribute-name=\"line-height\" line-height=\"1.7\"></mj-html-attribute>\n<mj-html-attribute class=\"easy-email\" multiple-attributes=\"false\" attribute-name=\"font-weight\" font-weight=\"400\"></mj-html-attribute>\n<mj-html-attribute class=\"easy-email\" multiple-attributes=\"false\" attribute-name=\"responsive\" responsive=\"true\"></mj-html-attribute>\n\n    </mj-html-attributes>\n  \n              \n              \n              \n              <mj-breakpoint width=\"480px\" />\n              \n              \n            <mj-attributes>\n              \n              <mj-all font-family=\"-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif\" />\n              <mj-text font-size=\"14px\" />\n              <mj-text color=\"#111827\" />\n        <mj-text line-height=\"1.7\" />\n        <mj-text font-weight=\"400\" />\n              \n\n            </mj-attributes>\n          </mj-head>\n          <mj-body background-color=\"#f4f4f5\" width=\"600px\" ><mj-section padding=\"40px 0 16px\" border=\"none\" direction=\"ltr\" text-align=\"center\" background-repeat=\"repeat\" background-size=\"auto\" background-position=\"top center\" background-color=\"#f4f4f5\" ><mj-column padding=\"0px 0px 0px 0px\" border=\"none\" vertical-align=\"top\" width=\"100%\" ><mj-text padding=\"0 20px\" align=\"left\" font-size=\"26px\" color=\"#111827\" >{{shop_name}}</mj-text></mj-column></mj-section><mj-section padding=\"0 20px 20px\" background-repeat=\"repeat\" background-size=\"auto\" background-position=\"top center\" border=\"none\" direction=\"ltr\" text-align=\"center\" background-color=\"#f4f4f5\" ><mj-column padding=\"36px 32px\" border=\"none\" vertical-align=\"top\" width=\"100%\" background-color=\"#ffffff\" border-radius=\"10px\" ><mj-text padding=\"0 0 12px\" align=\"left\" font-size=\"24px\" color=\"#111827\" font-weight=\"600\" >Thank you for your order!</mj-text><mj-text padding=\"0 0 20px\" align=\"left\" font-size=\"16px\" color=\"#555555\" line-height=\"1.6\" >Hi {{full_name}}, we've received your order and it's now being processed. Here's a summary of your purchase.</mj-text><mj-text padding=\"0 0 8px\" align=\"left\" font-size=\"14px\" color=\"#6b7280\" font-weight=\"600\" >Items</mj-text><mj-raw >{{order_items}}</mj-raw><mj-divider align=\"center\" border-width=\"1px\" border-style=\"solid\" border-color=\"#eceff3\" padding=\"8px 0 16px\" ></mj-divider><mj-text padding=\"0 0 20px\" align=\"left\" font-size=\"14px\" color=\"#111827\" line-height=\"1.8\" ><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-spacing:0;border-collapse:collapse;background:#f9fafb;border:1px solid #eceff3;border-radius:8px;\"><tr><td style=\"padding:14px 18px;font-size:14px;color:#6b7280;\">Order</td><td align=\"right\" style=\"padding:14px 18px;font-size:14px;color:#111827;font-weight:600;\">{{order_no}}</td></tr></table></mj-text></mj-column></mj-section><mj-section padding=\"8px 0 28px\" background-repeat=\"repeat\" background-size=\"auto\" background-position=\"top center\" border=\"none\" direction=\"ltr\" text-align=\"center\" background-color=\"#f4f4f5\" ><mj-column padding=\"0px 0px 0px 0px\" border=\"none\" vertical-align=\"top\" width=\"100%\" ><mj-text padding=\"0 20px\" align=\"center\" font-size=\"13px\" color=\"#9ca3af\" line-height=\"1.6\" >You received this email because you placed an order with us. <a href=\"{{unsubscribe_url}}\" style=\"color:#9ca3af;text-decoration:underline;\">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml > ";

export const orderConfirmationHtml = "<!doctype html>\n<html lang=\"und\" dir=\"auto\" xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\">\n  <head>\n    <title></title>\n    <!--[if !mso]><!-->\n    <meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\">\n    <!--<![endif]-->\n    <meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n    <style type=\"text/css\">\n      #outlook a { padding:0; }\n      body { margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%; }\n      table, td { border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt; }\n      img { border:0;height:auto;line-height:100%; outline:none;text-decoration:none;-ms-interpolation-mode:bicubic; }\n      p { display:block;margin:13px 0; }\n    </style>\n    <!--[if mso]>\n    <noscript>\n    <xml>\n    <o:OfficeDocumentSettings>\n      <o:AllowPNG/>\n      <o:PixelsPerInch>96</o:PixelsPerInch>\n    </o:OfficeDocumentSettings>\n    </xml>\n    </noscript>\n    <![endif]-->\n    <!--[if lte mso 11]>\n    <style type=\"text/css\">\n      .mj-outlook-group-fix { width:100% !important; }\n    </style>\n    <![endif]-->\n    \n      <!--[if !mso]><!-->\n        <link href=\"https://fonts.googleapis.com/css?family=Roboto:300,400,500,700\" rel=\"stylesheet\" type=\"text/css\">\n        <style type=\"text/css\">\n          @import url(https://fonts.googleapis.com/css?family=Roboto:300,400,500,700);\n        </style>\n      <!--<![endif]-->\n\n    \n    \n    <style type=\"text/css\">\n      @media only screen and (min-width:480px) {\n        .mj-column-per-100 { width:100% !important; max-width: 100%; }\n      }\n    </style>\n    <style media=\"screen and (min-width:480px)\">\n      .moz-text-html .mj-column-per-100 { width:100% !important; max-width: 100%; }\n    </style>\n    \n    \n  \n    \n    \n    \n  </head>\n  <body style=\"word-spacing:normal;background-color:#f4f4f5;\">\n    \n    \n      <div\n         aria-roledescription=\"email\" style=\"background-color:#f4f4f5;\" role=\"article\" lang=\"und\" dir=\"auto\"\n      >\n        \n      \n      <!--[if mso | IE]><table align=\"center\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\" class=\"\" role=\"presentation\" style=\"width:600px;\" width=\"600\" bgcolor=\"#f4f4f5\" ><tr><td style=\"line-height:0px;font-size:0px;mso-line-height-rule:exactly;\"><![endif]-->\n    \n      \n      <div  style=\"background:#f4f4f5;background-color:#f4f4f5;margin:0px auto;max-width:600px;\">\n        \n        <table\n           align=\"center\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" style=\"background:#f4f4f5;background-color:#f4f4f5;width:100%;\"\n        >\n          <tbody>\n            <tr>\n              <td\n                 style=\"border:none;direction:ltr;font-size:0px;padding:40px 0 16px;text-align:center;\"\n              >\n                <!--[if mso | IE]><table role=\"presentation\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\"><tr><td class=\"\" style=\"vertical-align:top;width:600px;\" ><![endif]-->\n            \n      <div\n         class=\"mj-column-per-100 mj-outlook-group-fix\" style=\"font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;\"\n      >\n        \n      <table\n         border=\"0\" cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" width=\"100%\"\n      >\n        <tbody>\n          <tr>\n            <td  style=\"border:none;vertical-align:top;padding:0px 0px 0px 0px;\">\n              \n      <table\n         border=\"0\" cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" style=\"\" width=\"100%\"\n      >\n        <tbody>\n          \n              <tr>\n                <td\n                   align=\"left\" style=\"font-size:0px;padding:0 20px;word-break:break-word;\"\n                >\n                  \n      <div\n         style=\"font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:26px;font-weight:400;line-height:1.7;text-align:left;color:#111827;\"\n      >{{shop_name}}</div>\n    \n                </td>\n              </tr>\n            \n        </tbody>\n      </table>\n    \n            </td>\n          </tr>\n        </tbody>\n      </table>\n    \n      </div>\n    \n          <!--[if mso | IE]></td></tr></table><![endif]-->\n              </td>\n            </tr>\n          </tbody>\n        </table>\n        \n      </div>\n    \n      \n      <!--[if mso | IE]></td></tr></table><table align=\"center\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\" class=\"\" role=\"presentation\" style=\"width:600px;\" width=\"600\" bgcolor=\"#f4f4f5\" ><tr><td style=\"line-height:0px;font-size:0px;mso-line-height-rule:exactly;\"><![endif]-->\n    \n      \n      <div  style=\"background:#f4f4f5;background-color:#f4f4f5;margin:0px auto;max-width:600px;\">\n        \n        <table\n           align=\"center\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" style=\"background:#f4f4f5;background-color:#f4f4f5;width:100%;\"\n        >\n          <tbody>\n            <tr>\n              <td\n                 style=\"border:none;direction:ltr;font-size:0px;padding:0 20px 20px;text-align:center;\"\n              >\n                <!--[if mso | IE]><table role=\"presentation\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\"><tr><td class=\"\" style=\"vertical-align:top;width:560px;\" ><![endif]-->\n            \n      <div\n         class=\"mj-column-per-100 mj-outlook-group-fix\" style=\"font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;\"\n      >\n        \n      <table\n         border=\"0\" cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" width=\"100%\" style=\"border-collapse:separate;\"\n      >\n        <tbody>\n          <tr>\n            <td  style=\"background-color:#ffffff;border:none;border-radius:10px;vertical-align:top;border-collapse:separate;padding:36px 32px;\">\n              \n      <table\n         border=\"0\" cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" style=\"\" width=\"100%\"\n      >\n        <tbody>\n          \n              <tr>\n                <td\n                   align=\"left\" style=\"font-size:0px;padding:0 0 12px;word-break:break-word;\"\n                >\n                  \n      <div\n         style=\"font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:24px;font-weight:600;line-height:1.7;text-align:left;color:#111827;\"\n      >Thank you for your order!</div>\n    \n                </td>\n              </tr>\n            \n              <tr>\n                <td\n                   align=\"left\" style=\"font-size:0px;padding:0 0 20px;word-break:break-word;\"\n                >\n                  \n      <div\n         style=\"font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:16px;font-weight:400;line-height:1.6;text-align:left;color:#555555;\"\n      >Hi {{full_name}}, we've received your order and it's now being processed. Here's a summary of your purchase.</div>\n    \n                </td>\n              </tr>\n            \n              <tr>\n                <td\n                   align=\"left\" style=\"font-size:0px;padding:0 0 8px;word-break:break-word;\"\n                >\n                  \n      <div\n         style=\"font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:14px;font-weight:600;line-height:1.7;text-align:left;color:#6b7280;\"\n      >Items</div>\n    \n                </td>\n              </tr>\n            {{order_items}}\n              <tr>\n                <td\n                   align=\"center\" style=\"font-size:0px;padding:8px 0 16px;word-break:break-word;\"\n                >\n                  \n      <p\n         style=\"border-top:solid 1px #eceff3;font-size:1px;margin:0px auto;width:100%;\"\n      >\n      </p>\n      \n      <!--[if mso | IE]><table align=\"center\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-top:solid 1px #eceff3;font-size:1px;margin:0px auto;width:496px;\" role=\"presentation\" width=\"496px\" ><tr><td style=\"height:0;line-height:0;\"> &nbsp;\n</td></tr></table><![endif]-->\n    \n    \n                </td>\n              </tr>\n            \n              <tr>\n                <td\n                   align=\"left\" style=\"font-size:0px;padding:0 0 20px;word-break:break-word;\"\n                >\n                  \n      <div\n         style=\"font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:14px;font-weight:400;line-height:1.8;text-align:left;color:#111827;\"\n      ><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-spacing:0;border-collapse:collapse;background:#f9fafb;border:1px solid #eceff3;border-radius:8px;\"><tr><td style=\"padding:14px 18px;font-size:14px;color:#6b7280;\">Order</td><td align=\"right\" style=\"padding:14px 18px;font-size:14px;color:#111827;font-weight:600;\">{{order_no}}</td></tr></table></div>\n    \n                </td>\n              </tr>\n            \n        </tbody>\n      </table>\n    \n            </td>\n          </tr>\n        </tbody>\n      </table>\n    \n      </div>\n    \n          <!--[if mso | IE]></td></tr></table><![endif]-->\n              </td>\n            </tr>\n          </tbody>\n        </table>\n        \n      </div>\n    \n      \n      <!--[if mso | IE]></td></tr></table><table align=\"center\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\" class=\"\" role=\"presentation\" style=\"width:600px;\" width=\"600\" bgcolor=\"#f4f4f5\" ><tr><td style=\"line-height:0px;font-size:0px;mso-line-height-rule:exactly;\"><![endif]-->\n    \n      \n      <div  style=\"background:#f4f4f5;background-color:#f4f4f5;margin:0px auto;max-width:600px;\">\n        \n        <table\n           align=\"center\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" style=\"background:#f4f4f5;background-color:#f4f4f5;width:100%;\"\n        >\n          <tbody>\n            <tr>\n              <td\n                 style=\"border:none;direction:ltr;font-size:0px;padding:8px 0 28px;text-align:center;\"\n              >\n                <!--[if mso | IE]><table role=\"presentation\" border=\"0\" cellpadding=\"0\" cellspacing=\"0\"><tr><td class=\"\" style=\"vertical-align:top;width:600px;\" ><![endif]-->\n            \n      <div\n         class=\"mj-column-per-100 mj-outlook-group-fix\" style=\"font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;\"\n      >\n        \n      <table\n         border=\"0\" cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" width=\"100%\"\n      >\n        <tbody>\n          <tr>\n            <td  style=\"border:none;vertical-align:top;padding:0px 0px 0px 0px;\">\n              \n      <table\n         border=\"0\" cellpadding=\"0\" cellspacing=\"0\" role=\"presentation\" style=\"\" width=\"100%\"\n      >\n        <tbody>\n          \n              <tr>\n                <td\n                   align=\"center\" style=\"font-size:0px;padding:0 20px;word-break:break-word;\"\n                >\n                  \n      <div\n         style=\"font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;font-size:13px;font-weight:400;line-height:1.6;text-align:center;color:#9ca3af;\"\n      >You received this email because you placed an order with us. <a href=\"{{unsubscribe_url}}\" style=\"color:#9ca3af;text-decoration:underline;\">Unsubscribe</a></div>\n    \n                </td>\n              </tr>\n            \n        </tbody>\n      </table>\n    \n            </td>\n          </tr>\n        </tbody>\n      </table>\n    \n      </div>\n    \n          <!--[if mso | IE]></td></tr></table><![endif]-->\n              </td>\n            </tr>\n          </tbody>\n        </table>\n        \n      </div>\n    \n      \n      <!--[if mso | IE]></td></tr></table><![endif]-->\n    \n    \n      </div>\n    \n  </body>\n</html>\n  ";
