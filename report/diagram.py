"""The architecture diagram, written as SVG so it stays sharp in the PDF."""

DIAGRAM = """
<svg viewBox="0 0 800 352" xmlns="http://www.w3.org/2000/svg" role="img"
     aria-label="A load generator reaches only the load balancer on Sys1, over plain HTTP on
                 port 4229 or HTTPS on 3229. The balancer polls each of the three chat back ends
                 on Sys2, Sys3 and Sys4 for its load several times a second and routes each
                 request to the least loaded back end that is still under the threshold. All
                 three back ends share one MongoDB replica set on Sys4. Sys1 also runs an
                 unrelated service on port 5229 that this deployment leaves alone.">
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#8a929b"/>
    </marker>
    <marker id="arp" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#1baf7a"/>
    </marker>
    <marker id="ard" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#a98a4e"/>
    </marker>
    <style>
      .box   { fill:#ffffff; stroke:#c3cad2; stroke-width:1.2; rx:5; }
      .lbbox { fill:#eef4f8; stroke:#14496b; stroke-width:1.6; rx:5; }
      .dbbox { fill:#fbf7ef; stroke:#a98a4e; stroke-width:1.3; rx:5; }
      .ghost { fill:#f6f7f9; stroke:#dfe3e8; stroke-width:1; rx:5; stroke-dasharray:4 3; }
      .group { fill:none; stroke:#c3cad2; stroke-width:1; rx:6; stroke-dasharray:3 3; }
      .t     { font-family:'Source Sans 3',Helvetica,sans-serif; font-size:11.5px; fill:#16191d; font-weight:600; }
      .tg    { font-family:'Source Sans 3',Helvetica,sans-serif; font-size:10.5px; fill:#9aa1aa; font-weight:600; }
      .s     { font-family:'JetBrains Mono',monospace; font-size:8.6px; fill:#767d87; }
      .sg    { font-family:'JetBrains Mono',monospace; font-size:8.2px; fill:#b0b6bd; }
      .lbl   { font-family:'Source Sans 3',Helvetica,sans-serif; font-size:8.8px; fill:#767d87; }
      .lblp  { font-family:'Source Sans 3',Helvetica,sans-serif; font-size:8.6px; fill:#1baf7a; font-weight:600; }
      .ln    { stroke:#8a929b; stroke-width:1.3; fill:none; marker-end:url(#ar); }
      .lnp   { stroke:#1baf7a; stroke-width:1; fill:none; stroke-dasharray:2 2; marker-end:url(#arp); }
      .lnd   { stroke:#a98a4e; stroke-width:1; fill:none; stroke-dasharray:3 3; marker-end:url(#ard); }
    </style>
  </defs>

  <rect class="box" x="6" y="118" width="126" height="52"/>
  <text class="t" x="20" y="140">Clients</text>
  <text class="s" x="20" y="155">load generator,</text>
  <text class="s" x="20" y="166">browser</text>

  <line class="ln" x1="136" y1="136" x2="212" y2="136"/>
  <text class="lbl" x="140" y="130">HTTP :4229</text>
  <line class="ln" x1="136" y1="156" x2="212" y2="156"/>
  <text class="lbl" x="140" y="171">HTTPS :3229</text>

  <rect class="lbbox" x="216" y="104" width="158" height="80"/>
  <text class="t" x="231" y="126">Sys1, load balancer</text>
  <text class="s" x="231" y="141">172.17.0.30</text>
  <text class="s" x="231" y="154">:4000 http  :3000 https</text>
  <text class="s" x="231" y="167">threshold + least loaded</text>

  <rect class="ghost" x="216" y="248" width="158" height="44"/>
  <text class="tg" x="231" y="267">another project</text>
  <text class="sg" x="231" y="281">:5000, untouched</text>

  <line class="ln" x1="378" y1="122" x2="556" y2="52"/>
  <line class="ln" x1="378" y1="144" x2="556" y2="144"/>
  <line class="ln" x1="378" y1="166" x2="556" y2="236"/>

  <rect class="box" x="560" y="26" width="194" height="52"/>
  <text class="t" x="574" y="46">Sys2, chat-1</text>
  <text class="s" x="574" y="61">172.17.0.31:4000</text>

  <rect class="box" x="560" y="118" width="194" height="52"/>
  <text class="t" x="574" y="138">Sys3, chat-2</text>
  <text class="s" x="574" y="153">172.17.0.32:4000</text>

  <rect class="group" x="548" y="198" width="218" height="120"/>

  <rect class="box" x="560" y="210" width="194" height="52"/>
  <text class="t" x="574" y="230">Sys4, chat-3</text>
  <text class="s" x="574" y="245">172.17.0.33:4000</text>

  <rect class="dbbox" x="560" y="272" width="194" height="34"/>
  <text class="t" x="574" y="291">MongoDB rs0 :27017</text>

  <path class="lnp" d="M556 66 C 500 78, 460 96, 380 110"/>
  <path class="lnp" d="M556 158 C 500 166, 460 172, 380 178"/>
  <path class="lnp" d="M556 246 C 500 236, 440 200, 380 186"/>
  <text class="lblp" x="388" y="222">/lb/load every 300 ms</text>

  <path class="lnd" d="M754 40 C 790 40, 790 160, 790 282 L 758 282"/>
  <path class="lnd" d="M754 132 C 776 132, 776 220, 776 288 L 758 288"/>
  <text class="lbl" x="400" y="344">chat-3 uses the same database over the loopback; all three share one history</text>
</svg>
"""
