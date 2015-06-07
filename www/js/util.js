'use strict';

function writeOutMessage(message) {
  var elem = document.getElementById('out');
  elem.appendChild(document.createTextNode(message));
  elem.appendChild(document.createElement('br'));
}
